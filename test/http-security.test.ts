/**
 * Hosted mode: the security-sensitive edges of the claude.ai connector.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { Sealer } from "../src/http/seal.js";
import { startMockSimpro, type MockOptions, type MockSimpro } from "../src/mock/simpro.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Env {
  base: string;
  mock: MockSimpro;
  stateDir: string;
  stop(): Promise<void>;
}

async function startEnv(opts: { mock?: MockOptions; mockInstance?: MockSimpro; stateDir?: string; port?: number; writeMode?: string } = {}): Promise<Env> {
  const mock = opts.mockInstance ?? (await startMockSimpro(opts.mock));
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "simpro-sec-"));
  const port = opts.port ?? (await freePort());
  const base = `http://localhost:${port}`;
  const cfg = loadConfig({
    SIMPRO_TRANSPORT: "http",
    SIMPRO_BASE_URL: mock.url,
    SIMPRO_CLIENT_ID: "mock-client",
    SIMPRO_CLIENT_SECRET: "mock-secret",
    PUBLIC_URL: base,
    SIMPRO_STATE_DIR: stateDir,
    SIMPRO_WRITE_MODE: opts.writeMode ?? "confirm",
  });
  const { app } = createHttpApp(cfg);
  const server: Server = await new Promise((r) => {
    const s = app.listen(port, "127.0.0.1", () => r(s));
  });
  const env: Env = {
    base,
    mock,
    stateDir,
    stop: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
  if (!opts.mockInstance) cleanups.push(() => mock.close());
  if (!opts.stateDir) cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  return env;
}

async function register(base: string): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs /authorize through Simpro and back, like a browser. Carries cookies. */
async function authorize(base: string, clientId: string, state = "s1") {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let next = `${base}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })}`;
  const cookies: string[] = [];
  for (let i = 0; i < 6; i++) {
    const sameHost = next.startsWith(base);
    const res = await fetch(next, { redirect: "manual", headers: sameHost && cookies.length ? { Cookie: cookies.join("; ") } : {} });
    for (const c of res.headers.getSetCookie()) cookies.push(c.split(";")[0]);
    const loc = res.headers.get("location");
    if (!loc) return { status: res.status, body: await res.text(), verifier };
    const url = new URL(loc, next);
    if (url.toString().startsWith(REDIRECT)) return { status: res.status, back: url, verifier };
    next = url.toString();
  }
  throw new Error("too many redirects");
}

async function token(base: string, params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function signIn(base: string) {
  const clientId = await register(base);
  const a = await authorize(base, clientId);
  const code = a.back!.searchParams.get("code")!;
  const t = await token(base, { grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: clientId, redirect_uri: REDIRECT });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  return { clientId, access: t.json.access_token as string, refresh: t.json.refresh_token as string };
}

async function mcp(base: string, accessToken: string) {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    let json: any;
    try {
      json = JSON.parse(r.content[0].text);
    } catch {
      /* error text */
    }
    return { isError: !!r.isError, text: r.content[0].text, json };
  };
  return { client, call };
}

const rawMcp = (base: string, auth?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("approving a change works across separate requests, but only for the same person", async () => {
  const env = await startEnv();
  cleanups.push(() => env.stop());
  const alice = await signIn(env.base);
  const bob = await signIn(env.base);
  assert.notEqual(alice.clientId, bob.clientId);

  const args = { entity: "job", id: 1002, subject: "Hosted", note: "via connector" };
  const a1 = await mcp(env.base, alice.access);
  const preview = await a1.call("add_note", args);
  assert.match(preview.json.status, /NOT DONE/);
  await a1.client.close();

  // Bob can't use Alice's approval token.
  const b = await mcp(env.base, bob.access);
  const stolen = await b.call("add_note", { ...args, confirmToken: preview.json.confirmToken });
  assert.equal(stolen.isError, true);
  assert.match(stolen.text, /does not match/);
  await b.client.close();

  // Alice, in a brand new request/connection, can.
  const a2 = await mcp(env.base, alice.access);
  const done = await a2.call("add_note", { ...args, confirmToken: preview.json.confirmToken });
  assert.equal(done.isError, false, done.text);
  assert.equal(done.json.status, "done");
  await a2.client.close();

  const posts = env.mock.requests.filter((r) => r.method === "POST" && r.path === "jobs/1002/notes/");
  assert.equal(posts.length, 1, "exactly one write reached Simpro");

  const audit = readFileSync(join(env.stateDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user, alice.clientId);
  assert.equal(audit[0].path, "jobs/1002/notes/");
});

test("forged, tampered, expired and wrong-type tokens are all rejected", async () => {
  const env = await startEnv();
  cleanups.push(() => env.stop());
  const { access, refresh } = await signIn(env.base);
  assert.equal((await rawMcp(env.base, access)).status, 200);

  const flip = access.slice(0, 20) + (access[20] === "A" ? "B" : "A") + access.slice(21);
  assert.equal((await rawMcp(env.base, flip)).status, 401, "tampered");
  assert.equal((await rawMcp(env.base, "mock-key")).status, 401, "raw Simpro key is not accepted");
  assert.equal((await rawMcp(env.base, refresh)).status, 401, "refresh token can't be used as access token");

  // An expired token sealed with the real key.
  const secret = readFileSync(join(env.stateDir, ".secret-key"), "utf8").trim();
  const sealer = new Sealer(`${secret}:tokens`);
  const expired = sealer.seal({ t: "a", sat: "mock-key", cid: "x", exp: Math.floor(Date.now() / 1000) - 10 });
  const res = await rawMcp(env.base, expired);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /invalid_token/);
  // ...while a valid one sealed the same way is accepted (proves the test is meaningful).
  const valid = sealer.seal({ t: "a", sat: "mock-key", cid: "x", exp: Math.floor(Date.now() / 1000) + 60 });
  assert.equal((await rawMcp(env.base, valid)).status, 200);
});

test("refresh tokens are bound to the client that got them, and rotate", async () => {
  const env = await startEnv({ mock: { rotateRefreshTokens: true } });
  cleanups.push(() => env.stop());
  const alice = await signIn(env.base);
  const bobId = await register(env.base);

  const wrongClient = await token(env.base, { grant_type: "refresh_token", refresh_token: alice.refresh, client_id: bobId });
  assert.equal(wrongClient.status, 400);
  assert.equal(wrongClient.json.error, "invalid_grant");

  const ok = await token(env.base, { grant_type: "refresh_token", refresh_token: alice.refresh, client_id: alice.clientId });
  assert.equal(ok.status, 200);
  // Simpro rotated the refresh token, so the old one no longer works at Simpro.
  const reused = await token(env.base, { grant_type: "refresh_token", refresh_token: alice.refresh, client_id: alice.clientId });
  assert.equal(reused.status, 400);
  assert.match(reused.json.error_description, /reconnect/);
  // The new one does.
  const again = await token(env.base, { grant_type: "refresh_token", refresh_token: ok.json.refresh_token, client_id: alice.clientId });
  assert.equal(again.status, 200);
});

test("sign-in still works if Simpro drops the state parameter (cookie fallback)", async () => {
  const env = await startEnv({ mock: { dropState: true } });
  cleanups.push(() => env.stop());
  const clientId = await register(env.base);
  const a = await authorize(env.base, clientId, "claude-state-123");
  assert.ok(a.back, a.body);
  assert.equal(a.back!.searchParams.get("state"), "claude-state-123");
  assert.ok(a.back!.searchParams.get("code"));
});

test("a refused Simpro login is passed back to Claude as access_denied", async () => {
  const env = await startEnv({ mock: { loginError: "access_denied" } });
  cleanups.push(() => env.stop());
  const clientId = await register(env.base);
  const a = await authorize(env.base, clientId, "st");
  assert.equal(a.back!.searchParams.get("error"), "access_denied");
  assert.equal(a.back!.searchParams.get("state"), "st");
  assert.equal(a.back!.searchParams.get("code"), null);
});

test("callback with an unknown or replayed flow is refused", async () => {
  const env = await startEnv();
  cleanups.push(() => env.stop());
  const res = await fetch(`${env.base}/oauth/simpro/callback?code=x&state=made-up`, { redirect: "manual" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Sign-in expired/);
});

test("authorize refuses redirect URIs that weren't registered", async () => {
  const env = await startEnv();
  cleanups.push(() => env.stop());
  const clientId = await register(env.base);
  const res = await fetch(
    `${env.base}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/steal",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    })}`,
    { redirect: "manual" },
  );
  assert.equal(res.status, 400);
  assert.ok(!env.mock.requests.length, "never reached Simpro");
});

test("after a restart, registrations and issued tokens keep working", async () => {
  const mock = await startMockSimpro();
  cleanups.push(() => mock.close());
  const stateDir = mkdtempSync(join(tmpdir(), "simpro-restart-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const port = await freePort();

  const first = await startEnv({ mockInstance: mock, stateDir, port });
  const { clientId, access, refresh } = await signIn(first.base);
  await first.stop();
  // Let this test's HTTP client notice its pooled connections to the old server closed.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(join(stateDir, "oauth-clients.json")));

  const second = await startEnv({ mockInstance: mock, stateDir, port });
  cleanups.push(() => second.stop());
  assert.equal((await rawMcp(second.base, access)).status, 200, "old access token still valid");
  const r = await token(second.base, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
  assert.equal(r.status, 200, "old refresh token still valid");
  const a = await authorize(second.base, clientId);
  assert.ok(a.back?.searchParams.get("code"), "client registration survived");
});

test("read-only hosted server refuses writes", async () => {
  const env = await startEnv({ writeMode: "read_only" });
  cleanups.push(() => env.stop());
  const { access } = await signIn(env.base);
  const { client, call } = await mcp(env.base, access);
  const r = await call("simpro_write", { method: "PATCH", path: "jobs/1001", body: { Name: "x" }, summary: "rename" });
  assert.equal(r.isError, true);
  assert.match(r.text, /read-only/);
  await client.close();
  assert.ok(!env.mock.requests.some((x) => x.method !== "GET"));
});
