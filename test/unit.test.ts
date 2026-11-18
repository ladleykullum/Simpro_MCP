import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { clean, htmlToText, toText } from "../src/format.js";
import { Sealer } from "../src/http/seal.js";
import { WriteGuard, stableStringify } from "../src/safety.js";
import { buildQueryString, describeSimproError, normalizePath } from "../src/simpro/client.js";
import { RateLimiter } from "../src/simpro/rateLimiter.js";
import { agedBuckets, daysOverdue } from "../src/tools/invoices.js";
import { dateFilter, wildcard } from "../src/tools/context.js";

test("normalizePath applies Simpro's trailing-slash rules", () => {
  assert.equal(normalizePath("jobs"), "jobs/");
  assert.equal(normalizePath("/jobs/"), "jobs/");
  assert.equal(normalizePath("jobs/123/"), "jobs/123");
  assert.equal(normalizePath("jobs/123/sections"), "jobs/123/sections/");
  assert.equal(normalizePath("/api/v1.0/companies/0/quotes/5"), "quotes/5");
  assert.equal(normalizePath("https://x.simprosuite.com/api/v1.0/companies/0/sites/7/"), "sites/7");
  assert.equal(normalizePath("jobs//12"), "jobs/12");
});

test("buildQueryString keeps operators readable and encodes wildcards safely", () => {
  assert.equal(
    buildQueryString({ Stage: "in(Pending,Progress)", Name: "%ab%", skip: undefined, empty: "" }),
    "?Stage=in(Pending,Progress)&Name=%25ab%25",
  );
  assert.equal(buildQueryString({ columns: ["ID", "Name"] }), "?columns=ID,Name");
  assert.equal(buildQueryString({}), "");
});

test("describeSimproError gives readable messages", () => {
  const msg = describeSimproError(422, { errors: [{ path: "/Subject", message: "is required", value: null }] });
  assert.match(msg, /422/);
  assert.match(msg, /\/Subject: is required/);
  assert.match(describeSimproError(422, { message: "This job is currently locked by Bob" }), /close it/);
  assert.match(describeSimproError(404, undefined), /collections end with/);
});

test("query helpers", () => {
  assert.equal(dateFilter("2026-01-01", "2026-01-31"), "between(2026-01-01,2026-01-31)");
  assert.equal(dateFilter("2026-01-01"), "ge(2026-01-01)");
  assert.equal(dateFilter(undefined, "2026-01-31"), "le(2026-01-31)");
  assert.equal(dateFilter(), undefined);
  assert.equal(wildcard(" smith "), "%smith%");
  assert.equal(wildcard("  "), undefined);
});

test("htmlToText and clean", () => {
  assert.equal(htmlToText("<p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul>"), "Hello & welcome\n- One\n- Two");
  assert.deepEqual(clean({ a: null, b: "", c: [], d: {}, e: 0, f: false, g: "<p>x</p>", h: [null, 1] }), {
    c: [],
    e: 0,
    f: false,
    g: "x",
    h: [1],
  });
});

test("toText trims the largest array to fit", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ ID: i, Name: "x".repeat(50) }));
  const text = toText({ rows }, 5000);
  assert.ok(text.length <= 5000);
  assert.match(text, /showing \d+ of 500 items/);
  assert.equal(toText(undefined, 100), '{"success": true}');
});

test("WriteGuard: confirm mode previews, then accepts only the matching token", () => {
  let now = 1_000_000;
  const g = new WriteGuard("confirm", false, "secret", undefined, () => now);
  const first = g.check("POST", "jobs/1/notes/", { Subject: "a", Note: "b" });
  assert.equal(first.action, "preview");
  const token = first.action === "preview" ? first.confirmToken : "";

  // Same change, keys in a different order: accepted.
  assert.deepEqual(g.check("POST", "jobs/1/notes", { Note: "b", Subject: "a" }, token), { action: "execute" });
  // Different body: refused.
  assert.equal(g.check("POST", "jobs/1/notes/", { Subject: "a", Note: "CHANGED" }, token).action, "refuse");
  // Different path: refused.
  assert.equal(g.check("POST", "jobs/2/notes/", { Subject: "a", Note: "b" }, token).action, "refuse");
  // Garbage token: refused.
  assert.equal(g.check("POST", "jobs/1/notes/", { Subject: "a", Note: "b" }, "nope").action, "refuse");
  // Expired: refused.
  now += 11 * 60_000;
  assert.equal(g.check("POST", "jobs/1/notes/", { Subject: "a", Note: "b" }, token).action, "refuse");
});

test("WriteGuard: tokens are bound to the user", () => {
  const g = new WriteGuard("confirm", false, "secret");
  const p = g.check("PATCH", "jobs/1", { Name: "x" }, undefined, "alice");
  const token = p.action === "preview" ? p.confirmToken : "";
  assert.equal(g.check("PATCH", "jobs/1", { Name: "x" }, token, "bob").action, "refuse");
  assert.equal(g.check("PATCH", "jobs/1", { Name: "x" }, token, "alice").action, "execute");
});

test("WriteGuard: read_only, delete and auto modes", () => {
  assert.equal(new WriteGuard("read_only", true).check("POST", "jobs/", {}).action, "refuse");
  assert.equal(new WriteGuard("auto", false).check("DELETE", "jobs/1", undefined).action, "refuse");
  assert.equal(new WriteGuard("auto", true).check("DELETE", "jobs/1", undefined).action, "execute");
  assert.equal(new WriteGuard("auto", false).check("PATCH", "jobs/1", {}).action, "execute");
});

test("stableStringify sorts keys", () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});

test("Sealer round-trips and rejects tampering or wrong keys", () => {
  const s = new Sealer("k1");
  const t = s.seal({ hello: "world" });
  assert.deepEqual(s.unseal(t), { hello: "world" });
  assert.equal(new Sealer("k2").unseal(t), undefined);
  const bad = t.slice(0, -2) + (t.endsWith("A") ? "BB" : "AA");
  assert.equal(s.unseal(bad), undefined);
  assert.equal(s.unseal("short"), undefined);
});

test("aged receivables buckets", () => {
  assert.equal(daysOverdue("2026-01-01", "2026-01-11"), 10);
  const r = agedBuckets(
    [
      { Customer: { ID: 1 }, DueDate: "2026-02-01", Total: { IncTax: 100 } },
      { Customer: { ID: 1 }, DueDate: "2026-01-20", Total: { IncTax: 50 } },
      { Customer: { ID: 2 }, DueDate: "2025-10-01", Total: { IncTax: 200, BalanceDue: 150 } },
      { Customer: { ID: 3 }, Total: { IncTax: 10 } },
    ],
    "2026-01-31",
  );
  assert.equal(r.total, 310);
  assert.equal(r.buckets.current, 100);
  assert.equal(r.buckets["1-30"], 50);
  assert.equal(r.buckets["90+"], 150);
  assert.equal(r.buckets.noDueDate, 10);
  assert.equal(r.customers[0].owing, 150);
});

test("RateLimiter spaces out requests", async () => {
  const l = new RateLimiter(20, 2);
  const start = Date.now();
  for (let i = 0; i < 6; i++) await l.take();
  // 2 burst + 4 at 20/s ≈ 200ms
  assert.ok(Date.now() - start >= 150, `took ${Date.now() - start}ms`);
});

test("loadConfig validates settings", () => {
  const base = { SIMPRO_BASE_URL: "https://x.simprosuite.com/", SIMPRO_API_KEY: "k" };
  const c = loadConfig(base);
  assert.equal(c.baseUrl, "https://x.simprosuite.com");
  assert.equal(c.authMode, "api_key");
  assert.equal(c.writeMode, "confirm");
  assert.equal(c.allowDelete, false);
  assert.equal(loadConfig({ ...base, SIMPRO_BASE_URL: "https://x.simprosuite.com/api/v1.0" }).baseUrl, "https://x.simprosuite.com");
  assert.throws(() => loadConfig({}), /SIMPRO_BASE_URL/);
  assert.throws(() => loadConfig({ SIMPRO_BASE_URL: "https://x" }), /SIMPRO_API_KEY/);
  assert.throws(() => loadConfig({ ...base, SIMPRO_WRITE_MODE: "yolo" }), /WRITE_MODE/);
  assert.throws(() => loadConfig({ ...base, SIMPRO_TRANSPORT: "http" }), /SIMPRO_CLIENT_ID/);
  assert.throws(
    () => loadConfig({ ...base, SIMPRO_TRANSPORT: "http", SIMPRO_CLIENT_ID: "a", SIMPRO_CLIENT_SECRET: "b" }),
    /PUBLIC_URL/,
  );
  const oauth = loadConfig({ SIMPRO_BASE_URL: "https://x.simprosuite.com", SIMPRO_CLIENT_ID: "a", SIMPRO_CLIENT_SECRET: "b" });
  assert.equal(oauth.authMode, "authorization_code");
  assert.equal(oauth.tokenUrl, "https://x.simprosuite.com/oauth2/token");
});
