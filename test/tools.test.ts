/**
 * Runs every tool through a real MCP client against the simulated Simpro.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type WriteMode } from "../src/config.js";
import { startMockSimpro, type MockSimpro } from "../src/mock/simpro.js";
import { WriteGuard } from "../src/safety.js";
import { StaticToken } from "../src/simpro/auth.js";
import { SimproClient } from "../src/simpro/client.js";
import { RateLimiter } from "../src/simpro/rateLimiter.js";
import { buildServer } from "../src/server.js";

let mock: MockSimpro;

before(async () => {
  mock = await startMockSimpro();
});
after(async () => {
  await mock.close();
});

async function connect(opts: { writeMode?: WriteMode; allowDelete?: boolean; token?: string } = {}) {
  const cfg = loadConfig({
    SIMPRO_BASE_URL: mock.url,
    SIMPRO_API_KEY: "mock-key",
    SIMPRO_WRITE_MODE: opts.writeMode ?? "confirm",
    SIMPRO_ALLOW_DELETE: opts.allowDelete ? "true" : "false",
  });
  const simpro = new SimproClient({
    baseUrl: cfg.baseUrl,
    companyId: 0,
    tokens: new StaticToken(opts.token ?? "mock-key"),
    limiter: new RateLimiter(1000),
    backoffMs: 5,
  });
  const server = buildServer(simpro, new WriteGuard(cfg.writeMode, cfg.allowDelete, "test-secret"), cfg);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = r.content[0].text;
    let json: any;
    try {
      json = JSON.parse(text.replace(/\n\n\[Result[\s\S]*$/, ""));
    } catch {
      json = undefined;
    }
    return { isError: !!r.isError, text, json };
  };
  return { client, call };
}

describe("tools against simulated Simpro", () => {
  test("lists all tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "add_note",
      "aged_receivables",
      "customer_overview",
      "find_customers",
      "find_invoices",
      "find_jobs",
      "find_quotes",
      "find_schedule",
      "find_sites",
      "get_invoice",
      "get_job",
      "get_quote",
      "get_site",
      "job_financials",
      "list_staff",
      "quote_pipeline",
      "simpro_api_guide",
      "simpro_get",
      "simpro_write",
    ]);
  });

  test("find_jobs filters by stage and name and pages", async () => {
    const { call } = await connect();
    const r = await call("find_jobs", { stage: ["Progress"] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.rows.map((j: any) => j.ID).sort(), [1001, 1005]);
    const byName = await call("find_jobs", { name: "switchboard" });
    assert.deepEqual(byName.json.rows.map((j: any) => j.ID), [1001]);
    const paged = await call("find_jobs", { pageSize: 2 });
    assert.equal(paged.json.pagination.totalRows, 5);
    assert.equal(paged.json.pagination.totalPages, 3);
    assert.match(paged.json.pagination.next, /page: 2/);
  });

  test("get_job with related data, HTML converted to text", async () => {
    const { call } = await connect();
    const r = await call("get_job", { jobId: 1001, include: ["costCenters", "notes", "schedule", "invoices"] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.job.Name, "Tower A switchboard upgrade");
    assert.match(r.json.job.Description, /- Level 1/);
    assert.equal(r.json.sections[0].costCenters.length, 2);
    assert.equal(r.json.schedule.length, 2);
    assert.equal(r.json.invoices[0].ID, 3001);
    assert.equal(r.json.notes[0].Subject, "Access");
  });

  test("get_job for a missing job is a readable error", async () => {
    const { call } = await connect();
    const r = await call("get_job", { jobId: 99999 });
    assert.equal(r.isError, true);
    assert.match(r.text, /HTTP 404/);
  });

  test("job_financials sums invoices", async () => {
    const { call } = await connect();
    const r = await call("job_financials", { jobId: 1002 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.invoicing.invoiceCount, 2);
    assert.equal(r.json.invoicing.invoicedIncTax, 2760);
    assert.equal(r.json.invoicing.unpaidIncTax, 1380);
    assert.equal(r.json.invoicing.percentInvoiced, "100%");
  });

  test("find_schedule by staff and list_staff", async () => {
    const { call } = await connect();
    const r = await call("find_schedule", { staffId: 1 });
    assert.deepEqual(r.json.rows.map((s: any) => s.ID), [5001, 5004]);
    const staff = await call("list_staff", { name: "dave", includeContractors: true });
    assert.deepEqual(staff.json.employees, [{ ID: 2, Name: "Dave Clarke" }]);
    assert.equal(staff.json.contractors.length, 0);
  });

  test("find_quotes open only and quote_pipeline", async () => {
    const { call } = await connect();
    const open = await call("find_quotes", { openOnly: true });
    assert.deepEqual(open.json.rows.map((q: any) => q.ID).sort(), [2001, 2002]);
    const big = await call("find_quotes", { minValueExTax: 10000 });
    assert.deepEqual(big.json.rows.map((q: any) => q.ID), [2001]);
    const pipe = await call("quote_pipeline", {});
    assert.equal(pipe.json.quotes, 4);
    assert.equal(pipe.json.byStage.Complete.valueExTax, 21000);
    assert.equal(pipe.json.byStage["Approved (closed)"].count, 1);
  });

  test("get_quote", async () => {
    const { call } = await connect();
    const r = await call("get_quote", { quoteId: 2002, include: ["costCenters", "notes"] });
    assert.equal(r.json.quote.Name, "Dairy LED lighting");
  });

  test("invoices: unpaid, overdue and aged receivables", async () => {
    const { call } = await connect();
    const unpaid = await call("find_invoices", { unpaidOnly: true });
    assert.deepEqual(unpaid.json.rows.map((i: any) => i.ID).sort(), [3001, 3002, 3004]);
    const overdue = await call("find_invoices", { overdueOnly: true });
    assert.deepEqual(overdue.json.rows.map((i: any) => i.ID).sort(), [3002, 3004]);
    const aged = await call("aged_receivables", {});
    assert.equal(aged.json.unpaidInvoices, 3);
    assert.equal(aged.json.totalOwing, 10637.5 + 11270 + 1380);
    assert.equal(aged.json.topCustomers[0].customer.ID, 202);
    const inv = await call("get_invoice", { invoiceId: 3001 });
    assert.equal(inv.json.ID, 3001);
  });

  test("customers: find across companies and individuals, overview", async () => {
    const { call } = await connect();
    const r = await call("find_customers", { name: "smith" });
    assert.deepEqual(r.json.companies.rows.map((c: any) => c.ID), [103]);
    assert.deepEqual(r.json.individuals.map((c: any) => c.ID), [202]);
    const ov = await call("customer_overview", { customerId: 101 });
    assert.equal(ov.json.customerType, "company");
    assert.equal(ov.json.contacts[0].GivenName, "Priya");
    assert.equal(ov.json.sites[0].ID, 301);
    assert.deepEqual(ov.json.openJobs.map((j: any) => j.ID).sort(), [1001, 1005]);
    assert.deepEqual(ov.json.openQuotes.map((q: any) => q.ID), [2001]);
    assert.deepEqual(ov.json.unpaidInvoices.map((i: any) => i.ID), [3001]);
    const ind = await call("customer_overview", { customerId: 202 });
    assert.equal(ind.json.customerType, "individual");
  });

  test("sites", async () => {
    const { call } = await connect();
    const r = await call("find_sites", { address: "beach" });
    assert.deepEqual(r.json.rows.map((s: any) => s.ID), [304]);
    const s = await call("get_site", { siteId: 301, includeJobs: true });
    assert.equal(s.json.recentJobs.length, 2);
  });

  test("simpro_get for collections and records, and the guide", async () => {
    const { call } = await connect();
    const c = await call("simpro_get", { path: "employees", query: { columns: "ID,Name" } });
    assert.equal(c.json.pagination.totalRows, 3);
    const one = await call("simpro_get", { path: "/jobs/1003/" });
    assert.equal(one.json.Name, "Heat pump install");
    const guide = await call("simpro_api_guide");
    assert.match(guide.text, /Simpro API quick reference/);
  });

  test("add_note: preview first, executes only with the token", async () => {
    const { call } = await connect();
    const before = mock.requests.filter((r) => r.method === "POST").length;
    const args = { entity: "job", id: 1003, subject: "Parts", note: "Heat pump arriving Tuesday\nCall customer" };
    const preview = await call("add_note", args);
    assert.equal(preview.isError, false, preview.text);
    assert.match(preview.json.status, /NOT DONE/);
    assert.equal(mock.requests.filter((r) => r.method === "POST").length, before, "preview must not write");

    const tampered = await call("add_note", { ...args, note: "something else", confirmToken: preview.json.confirmToken });
    assert.equal(tampered.isError, true);

    const done = await call("add_note", { ...args, confirmToken: preview.json.confirmToken });
    assert.equal(done.isError, false, done.text);
    assert.equal(done.json.status, "done");
    assert.ok(done.json.resourceId);
    const post = mock.requests.filter((r) => r.method === "POST").at(-1)!;
    assert.equal(post.path, "jobs/1003/notes/");
    assert.deepEqual(post.body, { Subject: "Parts", Note: "Heat pump arriving Tuesday<br>Call customer" });
  });

  test("simpro_write: delete refused by default, read_only refuses everything, auto writes", async () => {
    const { call } = await connect();
    const del = await call("simpro_write", { method: "DELETE", path: "jobs/1004", summary: "Delete job 1004" });
    assert.equal(del.isError, true);
    assert.match(del.text, /Deleting is turned off/);

    const ro = await connect({ writeMode: "read_only" });
    const r = await ro.call("simpro_write", { method: "PATCH", path: "jobs/1004", body: { Name: "x" }, summary: "Rename" });
    assert.equal(r.isError, true);
    assert.match(r.text, /read-only/);

    const auto = await connect({ writeMode: "auto" });
    const w = await auto.call("simpro_write", {
      method: "PATCH",
      path: "jobs/1005",
      body: { Name: "Tower A emergency lighting test (annual)" },
      summary: "Rename job 1005",
    });
    assert.equal(w.isError, false, w.text);
    assert.equal(w.json.httpStatus, 204);
    const check = await auto.call("get_job", { jobId: 1005 });
    assert.equal(check.json.job.Name, "Tower A emergency lighting test (annual)");
  });

  test("Simpro validation errors come back readable", async () => {
    const { call } = await connect({ writeMode: "auto" });
    const r = await call("simpro_write", { method: "POST", path: "jobs/1001/notes/", body: { Note: "no subject" }, summary: "bad note" });
    assert.equal(r.isError, true);
    assert.match(r.text, /422.*\/Subject: Subject is required/);
  });

  test("bad credentials give a clear error", async () => {
    const { call } = await connect({ token: "wrong" });
    const r = await call("find_jobs", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /HTTP 401/);
  });
});

describe("rate limiting", () => {
  test("retries after HTTP 429", async () => {
    const limited = await startMockSimpro({ rateLimitFirst: 2 });
    try {
      const client = new SimproClient({
        baseUrl: limited.url,
        companyId: 0,
        tokens: new StaticToken("mock-key"),
        limiter: new RateLimiter(1000),
        backoffMs: 5,
      });
      const p = await client.list("jobs/", {});
      assert.equal(p.totalRows, 5);
      assert.equal(limited.requests.length, 3);
    } finally {
      await limited.close();
    }
  });
});
