/**
 * Local sign-in (browser login, saved refresh token, client credentials) and
 * the Simpro client's retry and paging behaviour.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadDotEnv } from "../src/config.js";
import { startMockSimpro, type MockSimpro } from "../src/mock/simpro.js";
import {
  ClientCredentialsProvider,
  FileTokenStore,
  RefreshTokenProvider,
  StaticToken,
  type RefreshTokenStore,
} from "../src/simpro/auth.js";
import { browserLogin } from "../src/simpro/browserLogin.js";
import { SimproClient, type TokenProvider } from "../src/simpro/client.js";
import { RateLimiter } from "../src/simpro/rateLimiter.js";

let mock: MockSimpro;
let dir: string;
const app = () => ({ tokenUrl: `${mock.url}/oauth2/token`, clientId: "mock-client", clientSecret: "mock-secret" });

before(async () => {
  mock = await startMockSimpro({ rotateRefreshTokens: true });
  dir = mkdtempSync(join(tmpdir(), "simpro-auth-"));
});
after(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Acts like the user's browser: follows redirects from the Simpro login to the local callback. */
async function fakeBrowser(url: string): Promise<string> {
  let next = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(next, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc) return res.text();
    next = new URL(loc, next).toString();
  }
  throw new Error("too many redirects");
}

class MemoryStore implements RefreshTokenStore {
  saved: string[] = [];
  constructor(public value?: string) {}
  load() {
    return this.value;
  }
  save(t: string) {
    this.value = t;
    this.saved.push(t);
  }
}

describe("browser login (npm run login)", () => {
  test("opens Simpro, catches the redirect, and returns tokens", async () => {
    const port = await freePort();
    let page = "";
    const tokens = await browserLogin({
      ...app(),
      authorizeUrl: `${mock.url}/oauth2/login`,
      port,
      openUrl: (u) => {
        const url = new URL(u);
        assert.equal(url.searchParams.get("client_id"), "mock-client");
        assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${port}/callback`);
        void fakeBrowser(u).then((t) => (page = t));
      },
    });
    assert.match(tokens.access_token, /^mock-access-/);
    assert.match(tokens.refresh_token ?? "", /^mock-refresh-/);
    await new Promise((r) => setTimeout(r, 20));
    assert.match(page, /Signed in to Simpro/);
  });

  test("works when Simpro doesn't send state back", async () => {
    const noState = await startMockSimpro({ dropState: true });
    try {
      const tokens = await browserLogin({
        tokenUrl: `${noState.url}/oauth2/token`,
        clientId: "mock-client",
        clientSecret: "mock-secret",
        authorizeUrl: `${noState.url}/oauth2/login`,
        port: await freePort(),
        openUrl: (u) => void fakeBrowser(u),
      });
      assert.ok(tokens.access_token);
    } finally {
      await noState.close();
    }
  });

  test("rejects a mismatched state (possible forgery)", async () => {
    const port = await freePort();
    await assert.rejects(
      browserLogin({
        ...app(),
        authorizeUrl: `${mock.url}/oauth2/login`,
        port,
        openUrl: () => void fetch(`http://localhost:${port}/callback?code=x&state=forged`),
      }),
      /state mismatch/,
    );
  });

  test("reports a refused login", async () => {
    const refused = await startMockSimpro({ loginError: "access_denied" });
    try {
      await assert.rejects(
        browserLogin({
          tokenUrl: `${refused.url}/oauth2/token`,
          clientId: "mock-client",
          clientSecret: "mock-secret",
          authorizeUrl: `${refused.url}/oauth2/login`,
          port: await freePort(),
          openUrl: (u) => void fakeBrowser(u),
        }),
        /access_denied/,
      );
    } finally {
      await refused.close();
    }
  });

  test("reports a wrong client secret", async () => {
    await assert.rejects(
      browserLogin({
        ...app(),
        clientSecret: "wrong",
        authorizeUrl: `${mock.url}/oauth2/login`,
        port: await freePort(),
        openUrl: (u) => void fakeBrowser(u),
      }),
      /Simpro sign-in failed \(HTTP 401\)/,
    );
  });

  test("times out if nobody signs in", async () => {
    await assert.rejects(
      browserLogin({ ...app(), authorizeUrl: `${mock.url}/oauth2/login`, port: await freePort(), timeoutMs: 50, openUrl: () => {} }),
      /Timed out/,
    );
  });

  test("explains when the callback port is busy", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const { port } = blocker.address() as AddressInfo;
    try {
      await assert.rejects(
        browserLogin({ ...app(), authorizeUrl: `${mock.url}/oauth2/login`, port, openUrl: () => {} }),
        /Could not listen on http:\/\/localhost:\d+\/callback/,
      );
    } finally {
      blocker.close();
    }
  });
});

describe("saved login (refresh token)", () => {
  test("FileTokenStore round-trips and is private to the user", () => {
    const path = join(dir, "tokens.json");
    const store = new FileTokenStore(path);
    assert.equal(store.load(), undefined);
    store.save("mock-refresh-abc");
    assert.equal(store.load(), "mock-refresh-abc");
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, "not json");
    assert.equal(store.load(), undefined);
  });

  test("swaps the saved refresh token, saves the rotated one, and caches the access token", async () => {
    const first = await (await fetch(`${mock.url}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: "mock-client", client_secret: "mock-secret" }),
    })).json();
    assert.ok(first.access_token);
    // Get a real refresh token via a login.
    const login = await browserLogin({ ...app(), authorizeUrl: `${mock.url}/oauth2/login`, port: await freePort(), openUrl: (u) => void fakeBrowser(u) });
    const store = new MemoryStore(login.refresh_token);
    const provider = new RefreshTokenProvider(app(), store);

    const [a, b, c] = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(store.saved.length, 1, "concurrent callers share one refresh");
    assert.notEqual(store.value, login.refresh_token, "rotated refresh token is saved");
    assert.equal(await provider.getToken(), a, "cached until expiry");

    provider.invalidate();
    const d = await provider.getToken();
    assert.notEqual(d, a);
    assert.equal(store.saved.length, 2);
  });

  test("falls back to the browser login when the saved login was revoked", async () => {
    const store = new MemoryStore("mock-refresh-revoked-or-unknown");
    let logins = 0;
    const provider = new RefreshTokenProvider(app(), store, async () => {
      logins++;
      return { access_token: "mock-key", refresh_token: "mock-refresh-new", expires_in: 3600 };
    });
    // The mock rejects tokens it never issued.
    assert.equal(await provider.getToken(), "mock-key");
    assert.equal(logins, 1);
    assert.equal(store.value, "mock-refresh-new");
  });

  test("without a login function, says to run npm run login", async () => {
    const provider = new RefreshTokenProvider(app(), new MemoryStore());
    await assert.rejects(provider.getToken(), /npm run login/);
  });

  test("client credentials", async () => {
    const provider = new ClientCredentialsProvider(app());
    const t = await provider.getToken();
    assert.match(t, /^mock-access-/);
    const client = new SimproClient({ baseUrl: mock.url, companyId: 0, tokens: provider, limiter: new RateLimiter(1000) });
    assert.equal((await client.list("jobs/", {})).totalRows, 5);
    await assert.rejects(new ClientCredentialsProvider({ ...app(), clientSecret: "bad" }).getToken(), /HTTP 401/);
  });
});

describe("Simpro client", () => {
  test("after a 401, refreshes the token once and retries", async () => {
    let calls = 0;
    let invalidated = 0;
    const tokens: TokenProvider = {
      async getToken() {
        calls++;
        return calls === 1 ? "expired-token" : "mock-key";
      },
      invalidate() {
        invalidated++;
      },
    };
    const client = new SimproClient({ baseUrl: mock.url, companyId: 0, tokens, limiter: new RateLimiter(1000) });
    const job = await client.get<{ ID: number }>("jobs/1001");
    assert.equal(job.ID, 1001);
    assert.equal(invalidated, 1);

    // A token that stays bad gives up after one retry instead of looping.
    const stuck = new SimproClient({
      baseUrl: mock.url,
      companyId: 0,
      tokens: { getToken: async () => "bad", invalidate: () => {} },
      limiter: new RateLimiter(1000),
    });
    await assert.rejects(stuck.get("jobs/1001"), /HTTP 401/);
  });

  test("gives up after repeated 429s with a clear error", async () => {
    const limited = await startMockSimpro({ rateLimitFirst: 100 });
    try {
      const client = new SimproClient({
        baseUrl: limited.url,
        companyId: 0,
        tokens: new StaticToken("mock-key"),
        limiter: new RateLimiter(1000),
        maxRetries: 3,
        backoffMs: 1,
      });
      await assert.rejects(client.list("jobs/"), /HTTP 429/);
      assert.equal(limited.requests.length, 4, "1 try + 3 retries");
    } finally {
      await limited.close();
    }
  });

  test("listAll walks every page, and stops at maxRows", async () => {
    const big = await startMockSimpro({ extraJobs: 600 });
    try {
      const client = new SimproClient({ baseUrl: big.url, companyId: 0, tokens: new StaticToken("mock-key"), limiter: new RateLimiter(1000) });
      const all = await client.listAll("jobs/", { columns: "ID" });
      assert.equal(all.rows.length, 605);
      assert.equal(all.truncated, false);
      assert.equal(new Set(all.rows.map((r) => r.ID)).size, 605, "no duplicates across pages");
      assert.equal(big.requests.filter((r) => r.path === "jobs/").length, 3, "250-row pages");

      const capped = await client.listAll("jobs/", {}, 300);
      assert.equal(capped.rows.length, 300);
      assert.equal(capped.truncated, true);
      assert.equal(capped.totalRows, 605);
    } finally {
      await big.close();
    }
  });

  test("the shared rate limiter holds many parallel requests to the limit", async () => {
    const client = new SimproClient({
      baseUrl: mock.url,
      companyId: 0,
      tokens: new StaticToken("mock-key"),
      limiter: new RateLimiter(50, 5),
    });
    const start = Date.now();
    await Promise.all(Array.from({ length: 30 }, () => client.get("jobs/1001")));
    const ms = Date.now() - start;
    // 5 burst + 25 more at 50/s ≈ 500ms. Without the limiter it would take a few ms.
    assert.ok(ms >= 400, `30 requests took only ${ms}ms`);
  });

  test("builds company-scoped and unscoped URLs", () => {
    const c = new SimproClient({ baseUrl: "https://x.simprosuite.com", companyId: 3, tokens: new StaticToken("k") });
    assert.equal(c.url("jobs", { pageSize: 10 }), "https://x.simprosuite.com/api/v1.0/companies/3/jobs/?pageSize=10");
    assert.equal(c.url("currentUser/"), "https://x.simprosuite.com/api/v1.0/currentUser/");
    assert.equal(c.url("companies"), "https://x.simprosuite.com/api/v1.0/companies/");
    assert.equal(c.url("jobs/?Stage=Progress", { page: 2 }), "https://x.simprosuite.com/api/v1.0/companies/3/jobs/?Stage=Progress&page=2");
  });
});

test(".env loader: comments, quotes, and real environment wins", () => {
  const path = join(dir, ".env");
  writeFileSync(path, '# comment\nA_TEST_ONE=one\nA_TEST_TWO="two words"\nA_TEST_THREE=\'3\'\n\nnot a line\nA_TEST_KEEP=from-file\n');
  process.env.A_TEST_KEEP = "from-env";
  loadDotEnv(path);
  assert.equal(process.env.A_TEST_ONE, "one");
  assert.equal(process.env.A_TEST_TWO, "two words");
  assert.equal(process.env.A_TEST_THREE, "3");
  assert.equal(process.env.A_TEST_KEEP, "from-env");
  loadDotEnv(join(dir, "missing.env")); // no error
  assert.ok(readFileSync(path, "utf8").length > 0);
});
