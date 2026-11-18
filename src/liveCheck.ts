/**
 * Read-only health check of every lookup tool against a Simpro account.
 * Used by `npm run check` on the first run against a real build. It never
 * changes data: the server is built in read_only mode and no write tool is called.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "./config.js";
import { WriteGuard } from "./safety.js";
import type { SimproClient } from "./simpro/client.js";
import { buildServer } from "./server.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Things to look at by eye: shape of the data Simpro returned. */
  notes?: string[];
}

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

export async function runChecks(simpro: SimproClient, cfg: Config): Promise<CheckResult[]> {
  const readOnly: Config = { ...cfg, writeMode: "read_only", allowDelete: false };
  const server = buildServer(simpro, new WriteGuard("read_only", false), readOnly);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "simpro-check", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const results: CheckResult[] = [];
  async function check(name: string, tool: string, args: Record<string, unknown>, inspect?: (data: any) => string[] | void): Promise<any> {
    try {
      const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      const text = r.content[0]?.text ?? "";
      if (r.isError) {
        results.push({ name, ok: false, detail: text.slice(0, 300) });
        return undefined;
      }
      let data: any;
      try {
        data = JSON.parse(text.replace(/\n\n\[Result[\s\S]*$/, ""));
      } catch {
        data = text;
      }
      const count = data?.pagination?.totalRows ?? (Array.isArray(data?.rows) ? data.rows.length : undefined);
      const notes = inspect?.(data) ?? undefined;
      results.push({ name, ok: true, detail: count !== undefined ? `${count} found` : "ok", notes: notes || undefined });
      return data;
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error).message });
      return undefined;
    }
  }

  const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).join(", ") : "(none)");

  // Sign-in and permissions
  try {
    const me = await simpro.get<Record<string, unknown>>("currentUser/");
    results.push({ name: "Signed in", ok: true, detail: `as ${String(me?.Name ?? me?.ID ?? "unknown user")}` });
  } catch (err) {
    results.push({ name: "Signed in", ok: false, detail: (err as Error).message });
    // Nothing else will work without a valid login.
    if (/401/.test((err as Error).message)) return results;
  }

  // Jobs & scheduling
  const jobs = await check("find_jobs (in progress)", "find_jobs", { stage: ["Progress"], pageSize: 3 });
  const anyJobs = jobs?.rows?.length ? jobs : await check("find_jobs (any)", "find_jobs", { pageSize: 3 });
  const jobId = anyJobs?.rows?.[0]?.ID;
  await check("find_jobs (issued last 30 days)", "find_jobs", { dateFrom: iso(-30), dateTo: iso(0), pageSize: 1 });
  if (jobId) {
    await check(`get_job ${jobId} (with everything)`, "get_job", { jobId, include: ["costCenters", "notes", "schedule", "invoices"] }, (d) => [
      `job fields: ${keys(d?.job)}`,
    ]);
    await check(`job_financials ${jobId}`, "job_financials", { jobId }, (d) => [
      `Totals fields from Simpro: ${keys(d?.simproTotals)}`,
      `contract: ${JSON.stringify(d?.contract ?? null)}`,
    ]);
  }
  await check("find_schedule (this week)", "find_schedule", { dateFrom: iso(-3), dateTo: iso(4), pageSize: 3 }, (d) => [
    `booking fields: ${keys(d?.rows?.[0])}`,
  ]);
  const staff = await check("list_staff", "list_staff", {});
  const staffId = staff?.employees?.[0]?.ID;
  if (staffId) await check(`find_schedule (staff ${staffId})`, "find_schedule", { staffId, dateFrom: iso(-30), dateTo: iso(30), pageSize: 1 });

  // Quotes
  const quotes = await check("find_quotes (open)", "find_quotes", { openOnly: true, pageSize: 3 });
  const quoteId = quotes?.rows?.[0]?.ID;
  if (quoteId) await check(`get_quote ${quoteId}`, "get_quote", { quoteId, include: ["costCenters", "notes"] });
  await check("quote_pipeline (last 30 days)", "quote_pipeline", { dateFrom: iso(-30), dateTo: iso(0) }, (d) => [
    `stages seen: ${keys(d?.byStage)}`,
  ]);

  // Invoices
  const unpaid = await check("find_invoices (unpaid)", "find_invoices", { unpaidOnly: true, pageSize: 3 }, (d) => [
    `invoice Total fields: ${keys(d?.rows?.[0]?.Total)}  (look for a remaining-balance field)`,
    `has DueDate: ${d?.rows?.[0]?.DueDate !== undefined}`,
  ]);
  await check("find_invoices (overdue)", "find_invoices", { overdueOnly: true, pageSize: 3 });
  await check("aged_receivables", "aged_receivables", { top: 3 });
  const invoiceId = unpaid?.rows?.[0]?.ID;
  if (invoiceId) await check(`get_invoice ${invoiceId}`, "get_invoice", { invoiceId });

  // Customers & sites
  await check("find_customers ('a')", "find_customers", { name: "a", pageSize: 3 });
  const customerId = anyJobs?.rows?.[0]?.Customer?.ID;
  if (customerId) await check(`customer_overview ${customerId}`, "customer_overview", { customerId });
  const sites = await check("find_sites", "find_sites", { pageSize: 3 });
  const siteId = sites?.rows?.[0]?.ID;
  if (siteId) await check(`get_site ${siteId}`, "get_site", { siteId, includeJobs: true });

  // Generic
  await check("simpro_get employees/", "simpro_get", { path: "employees/", query: { columns: "ID,Name", pageSize: 1 } });

  await client.close();
  return results;
}

export function formatResults(results: CheckResult[]): string {
  const lines = results.map((r) => {
    const head = `${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`;
    return [head, ...(r.notes ?? []).map((n) => `    · ${n}`)].join("\n");
  });
  const failed = results.filter((r) => !r.ok).length;
  lines.push("", failed ? `${failed} of ${results.length} checks failed.` : `All ${results.length} checks passed.`);
  return lines.join("\n");
}
