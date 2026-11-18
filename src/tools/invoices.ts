import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  columnsArg,
  dateFilter,
  dateRange,
  filtersArg,
  listQuery,
  ok,
  pageResult,
  paging,
  safe,
  type ToolContext,
} from "./context.js";

const INVOICE_COLUMNS = ["ID", "Type", "Customer", "Jobs", "Stage", "Status", "DateIssued", "DueDate", "Total", "IsPaid"];

const today = () => new Date().toISOString().slice(0, 10);

/** Amount still owed on an invoice: Simpro's balance if it sends one, else the total. */
export function outstanding(inv: Record<string, any>): number {
  const t = inv.Total ?? {};
  for (const v of [t.BalanceDue, t.AmountOwing, t.IncTax]) if (typeof v === "number") return v;
  return 0;
}

export function daysOverdue(dueDate: string | undefined, asOf: string): number | undefined {
  if (!dueDate) return undefined;
  const ms = Date.parse(asOf) - Date.parse(dueDate.slice(0, 10));
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : undefined;
}

export function agedBuckets(rows: Array<Record<string, any>>, asOf: string) {
  const buckets = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, noDueDate: 0 };
  const byCustomer = new Map<string, { customer: unknown; owing: number; invoices: number; oldestDaysOverdue: number }>();
  for (const inv of rows) {
    const amount = outstanding(inv);
    const d = daysOverdue(inv.DueDate, asOf);
    const key = d === undefined ? "noDueDate" : d <= 0 ? "current" : d <= 30 ? "1-30" : d <= 60 ? "31-60" : d <= 90 ? "61-90" : "90+";
    buckets[key] += amount;
    const c = inv.Customer ?? {};
    const id = String(c.ID ?? "unknown");
    const entry = byCustomer.get(id) ?? { customer: c, owing: 0, invoices: 0, oldestDaysOverdue: 0 };
    entry.owing += amount;
    entry.invoices++;
    entry.oldestDaysOverdue = Math.max(entry.oldestDaysOverdue, d ?? 0);
    byCustomer.set(id, entry);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const k of Object.keys(buckets) as Array<keyof typeof buckets>) buckets[k] = r2(buckets[k]);
  const customers = [...byCustomer.values()]
    .map((c) => ({ ...c, owing: r2(c.owing) }))
    .sort((a, b) => b.owing - a.owing);
  const total = r2(Object.values(buckets).reduce((a, b) => a + b, 0));
  return { total, buckets, customers };
}

export function registerInvoiceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "find_invoices",
    {
      title: "Find invoices",
      description:
        "Search customer invoices by customer, job, date issued, paid/unpaid and overdue. Amounts are in Total (ExTax / Tax / IncTax).",
      inputSchema: {
        customerId: z.number().int().optional(),
        jobId: z.number().int().optional(),
        unpaidOnly: z.boolean().optional(),
        overdueOnly: z.boolean().optional().describe("Unpaid and past the due date."),
        ...dateRange,
        filters: filtersArg,
        columns: columnsArg,
        orderby: z.string().optional().describe("Default '-DateIssued'."),
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) => {
      const q = listQuery(ctx, args, { columns: INVOICE_COLUMNS, orderby: "-DateIssued" }, {
        "Customer.ID": args.customerId,
        "Jobs.ID": args.jobId,
        IsPaid: args.unpaidOnly || args.overdueOnly ? false : undefined,
        DueDate: args.overdueOnly ? `lt(${today()})` : undefined,
        DateIssued: dateFilter(args.dateFrom, args.dateTo),
      });
      return ok(pageResult(await ctx.client.list("invoices/", q)), ctx.cfg);
    }),
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice details",
      description: "Full details of one customer invoice.",
      inputSchema: { invoiceId: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ invoiceId }) => ok(await ctx.client.get(`invoices/${invoiceId}`), ctx.cfg)),
  );

  server.registerTool(
    "aged_receivables",
    {
      title: "Who owes us money",
      description:
        "All unpaid invoices grouped into age buckets (current, 1-30, 31-60, 61-90, 90+ days overdue) and by customer, largest debt first.",
      inputSchema: {
        customerId: z.number().int().optional(),
        top: z.number().int().min(1).max(200).optional().describe("How many customers to list (default 20)."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ customerId, top = 20 }) => {
      const asOf = today();
      const { rows, truncated } = await ctx.client.listAll<Record<string, any>>(
        "invoices/",
        { IsPaid: false, "Customer.ID": customerId, columns: "ID,Customer,DateIssued,DueDate,Total,IsPaid" },
        5000,
      );
      const summary = agedBuckets(rows, asOf);
      return ok(
        {
          asOf,
          unpaidInvoices: rows.length,
          totalOwing: summary.total,
          buckets: summary.buckets,
          topCustomers: summary.customers.slice(0, top),
          note: "Amounts are inc tax. If Simpro does not report a remaining balance, part-payments are not deducted.",
          ...(truncated ? { warning: "Only the first 5000 unpaid invoices were counted." } : {}),
        },
        ctx.cfg,
      );
    }),
  );
}
