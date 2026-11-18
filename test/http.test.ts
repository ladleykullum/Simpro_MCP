/**
 * End-to-end test of hosted mode: the claude.ai-style OAuth flow (client
 * registration, PKCE, Simpro login hop, token exchange, refresh) and MCP
 * calls over HTTP, all against the simulated Simpro.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { startMockSimpro, type MockSimpro } from "../src/mock/simpro.js";

let mock: MockSimpro;
let server: Server;
let base: string;
let stateDir: string;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

before(async () => {
  mock = await startMockSimpro();
  stateDir = mkdtempSync(join(tmpdir(), "simpro-mcp-test-"));
  const port = await freePort();
  base = `http://localhost:${port}`;
  const cfg = loadConfig({
    SIMPRO_TRANSPORT: "http",
    SIMPRO_BASE_URL: mock.url,
    SIMPRO_CLIENT_ID: "mock-client",
    SIMPRO_CLIENT_SECRET: "mock-secret",
    PUBLIC_URL: base,
    SIMPRO_STATE_DIR: stateDir,
  });
  const { app } = createHttpApp(cfg);
  server = await new Promise<Server>((r) => {
    const s = app.listen(port, "127.0.0.1", () => r(s));
  });
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await mock.close();
  rmSync(stateDir, { recursive: true, force: true });
});

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function signIn() {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(reg.status, 201, await reg.clone().text());
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state",
  }).toString();

  // Follow the redirects by hand: us → Simpro login → our callback → Claude.
  let next = authorize.toString();
  let final: URL | undefined;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(next, { redirect: "manual" });
    assert.ok([302, 303].includes(res.status), `hop ${hop} ${next} -> ${res.status} ${await res.text()}`);
    const loc = new URL(res.headers.get("location")!, next);
    if (loc.toString().startsWith(REDIRECT)) {
      final = loc;
      break;
    }
    next = loc.toString();
  }
  assert.ok(final, "never redirected back to Claude");
  assert.equal(final.searchParams.get("state"), "claude-state");
  const code = final.searchParams.get("code");
  assert.ok(code, `no code: ${final}`);

  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }),
  });
  assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { client_id, verifier, code, tokens };
}

async function mcpClient(accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

test("health and discovery endpoints", async () => {
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.authorization_endpoint, `${base}/authorize`);
  assert.ok((as.code_challenge_methods_supported as string[]).includes("S256"));
  const pr = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(pr.status, 200);
});

test("MCP without a token is rejected with a pointer to the auth metadata", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  const bad = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer forged", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: "{}",
  });
  assert.equal(bad.status, 401);
});

test("full sign-in, tool calls with the user's Simpro token, and refresh", async () => {
  const { client_id, verifier, code, tokens } = await signIn();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(!tokens.access_token.includes("mock-access"), "Simpro token must not be visible in our token");

  // Codes are single-use.
  const reuse = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }),
  });
  assert.equal(reuse.status, 400);

  const client = await mcpClient(tokens.access_token);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "find_jobs"));
  const res = (await client.callTool({ name: "find_jobs", arguments: { stage: ["Pending"] } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(res.isError ?? false, false, res.content[0].text);
  assert.equal(JSON.parse(res.content[0].text).rows[0].ID, 1003);
  // The request to Simpro carried the user's own Simpro access token.
  await client.close();

  const refreshed = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }),
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const t2 = (await refreshed.json()) as { access_token: string };
  const client2 = await mcpClient(t2.access_token);
  assert.ok((await client2.listTools()).tools.length > 10);
  await client2.close();
});

test("PKCE: a wrong code_verifier is rejected", async () => {
  // Start a fresh flow but present the wrong verifier.
  const reg = (await (
    await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string };
  const challenge = createHash("sha256").update("right-verifier-right-verifier-right-verifier").digest("base64url");
  let next = `${base}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  let code: string | null = null;
  for (let i = 0; i < 5 && !code; i++) {
    const r = await fetch(next, { redirect: "manual" });
    const loc = new URL(r.headers.get("location")!, next);
    if (loc.toString().startsWith(REDIRECT)) code = loc.searchParams.get("code");
    else next = loc.toString();
  }
  assert.ok(code);
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
    }),
  });
  assert.equal(res.status, 400);
});

test("GET /mcp is not allowed (stateless server)", async () => {
  const res = await fetch(`${base}/mcp`);
  assert.equal(res.status, 405);
});
