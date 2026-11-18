import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { formatResults, runChecks } from "../src/liveCheck.js";
import { startMockSimpro } from "../src/mock/simpro.js";
import { StaticToken } from "../src/simpro/auth.js";
import { SimproClient } from "../src/simpro/client.js";
import { RateLimiter } from "../src/simpro/rateLimiter.js";

const setup = async (token: string) => {
  const mock = await startMockSimpro();
  const cfg = loadConfig({ SIMPRO_BASE_URL: mock.url, SIMPRO_API_KEY: "mock-key", SIMPRO_WRITE_MODE: "auto", SIMPRO_ALLOW_DELETE: "true" });
  const client = new SimproClient({ baseUrl: mock.url, companyId: 0, tokens: new StaticToken(token), limiter: new RateLimiter(1000) });
  return { mock, cfg, client };
};

test("npm run check: every lookup passes against the simulated Simpro and nothing is written", async () => {
  const { mock, cfg, client } = await setup("mock-key");
  try {
    const results = await runChecks(client, cfg);
    const text = formatResults(results);
    assert.ok(results.every((r) => r.ok), text);
    assert.ok(results.length >= 20, `only ${results.length} checks ran:\n${text}`);
    assert.match(text, /Signed in: as Mere Thompson/);
    assert.match(text, /Totals fields from Simpro: /);
    assert.match(text, /invoice Total fields: ExTax, Tax, IncTax/);
    assert.match(text, /All \d+ checks passed/);
    assert.deepEqual(new Set(mock.requests.map((r) => r.method)), new Set(["GET"]), "read-only even when .env allows writes");
  } finally {
    await mock.close();
  }
});

test("npm run check: a bad login stops early with a clear failure", async () => {
  const { mock, cfg, client } = await setup("wrong");
  try {
    const results = await runChecks(client, cfg);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(formatResults(results), /✗ Signed in: .*401/);
  } finally {
    await mock.close();
  }
});
