/**
 * Edge cases: bad input from the model, oversized results, and awkward
 * answers from Simpro.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { startMockSimpro, type MockSimpro } from "../src/mock/simpro.js";
import { WriteGuard } from "../src/safety.js";
import { StaticToken } from "../src/simpro/auth.js";
import { SimproClient } from "../src/simpro/client.js";
import { RateLimiter } from "../src/simpro/rateLimiter.js";
import { buildServer } from "../src/server.js";

let mock: MockSimpro;
before(async () => {
  mock = await startMockSimpro({ extraJobs: 300, lockedPaths: ["quotes/2001"] });
});
after(async () => {
  await mock.close();
});

async function connect(env: Record<string, string> = {}) {
  const cfg = loadConfig({ SIMPRO_BASE_URL: mock.url, SIMPRO_API_KEY: "mock-key", ...env });
  const simpro = new SimproClient({ baseUrl: cfg.baseUrl, companyId: 0, tokens: new StaticToken("mock-key"), limiter: new RateLimiter(1000) });
  const server = buildServer(simpro, new WriteGuard(cfg.writeMode, cfg.allowDelete, "s"), cfg);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: !!r.isError, text: r.content[0].text };
  };
}

test("invalid arguments are rejected before anything is sent to Simpro", async () => {
  const call = await connect();
  const before = mock.requests.length;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["find_jobs", { stage: ["Finished"] }],
    ["find_jobs", { dateFrom: "18/11/2026" }],
    ["find_jobs", { pageSize: 1000 }],
    ["get_job", { jobId: "1001; DROP" }],
    ["get_job", { jobId: 10.5 }],
    ["get_job", {}],
    ["add_note", { entity: "invoice", id: 1, subject: "x", note: "y" }],
    ["add_note", { entity: "job", id: 1, subject: "", note: "y" }],
    ["simpro_write", { method: "GET", path: "jobs/", summary: "read" }],
    ["simpro_write", { method: "POST", path: "jobs/", body: {} }],
  ];
  for (const [name, args] of cases) {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} should be rejected`);
  }
  assert.equal(mock.requests.length, before, "no request reached Simpro");
});

test("unknown tools give an error, not a crash", async () => {
  const call = await connect();
  const r = await call("delete_everything");
  assert.equal(r.isError, true);
});

test("huge results are cut to fit, with a note saying so", async () => {
  const call = await connect({ SIMPRO_MAX_RESULT_CHARS: "4000" });
  const r = await call("find_jobs", { pageSize: 250, columns: ["ID", "Name", "Stage", "DateIssued"] });
  assert.equal(r.isError, false);
  assert.ok(r.text.length <= 4000, `got ${r.text.length} chars`);
  assert.match(r.text, /showing \d+ of 250 items/);
  // The pagination block survives, so the model still knows the real total.
  assert.match(r.text, /"totalRows": 305/);
});

test("a record locked in Simpro gives a helpful message", async () => {
  const call = await connect({ SIMPRO_WRITE_MODE: "auto" });
  const r = await call("simpro_write", { method: "PATCH", path: "quotes/2001", body: { Name: "x" }, summary: "rename quote" });
  assert.equal(r.isError, true);
  assert.match(r.text, /locked by Sam Lee/);
  assert.match(r.text, /Ask them to close it/);
});

test("simpro_get: wrong route and missing record are readable", async () => {
  const call = await connect();
  const bad = await call("simpro_get", { path: "nonsense/route" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /404/);
  const missing = await call("simpro_get", { path: "quotes/999999" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Record not found/);
});

test("searches with no matches return an empty list, not an error", async () => {
  const call = await connect();
  const jobs = await call("find_jobs", { name: "zzz-no-such-job" });
  assert.equal(jobs.isError, false);
  const parsed = JSON.parse(jobs.text);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.pagination.totalRows, 0);
  const people = JSON.parse((await call("find_customers", { name: "zzz", type: "individual" })).text);
  assert.deepEqual(people.individuals, []);
  assert.equal(people.companies, undefined);
});

test("wildcard characters typed by the user are treated as plain text", async () => {
  const call = await connect();
  const before = mock.requests.length;
  const all = JSON.parse((await call("find_jobs", { name: "%", pageSize: 5 })).text);
  // A lone "%" is ignored (no name filter) rather than becoming a pattern.
  assert.equal(mock.requests.at(-1)!.query.Name, undefined);
  assert.equal(all.pagination.totalRows, 305);
  const pump = JSON.parse((await call("find_jobs", { name: "pu%mp" })).text);
  assert.equal(mock.requests.at(-1)!.query.Name, "%pump%");
  assert.deepEqual(pump.rows.map((j: { ID: number }) => j.ID).sort(), [1002, 1003]);
  assert.equal(mock.requests.length, before + 2);
});

test("customer_overview still answers if one part fails", async () => {
  const call = await connect();
  // Customer 103 exists but has no contacts route data; the overview should still come back.
  const r = await call("customer_overview", { customerId: 103 });
  assert.equal(r.isError, false, r.text);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.customer.CompanyName, "Smith & Sons Builders");
  const missing = await call("customer_overview", { customerId: 424242 });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /404/);
});
