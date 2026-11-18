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
  wildcard,
  type ToolContext,
} from "./context.js";

const QUOTE_STAGES = ["InProgress", "Complete", "Approved", "Archived"] as const;
const QUOTE_COLUMNS = ["ID", "Name", "Customer", "Site", "Stage", "Status", "DateIssued", "DueDate", "Total", "IsClosed"];

export function registerQuoteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "find_quotes",
    {
      title: "Find quotes",
      description:
        "Search quotes by name text, customer, site, stage and issue date. Quote stages: InProgress, Complete, Approved, Archived. " +
        "'Open' quotes are usually stage InProgress or Complete that are not closed.",
      inputSchema: {
        name: z.string().optional().describe("Text the quote name contains."),
        customerId: z.number().int().optional(),
        siteId: z.number().int().optional(),
        stage: z.array(z.enum(QUOTE_STAGES)).optional(),
        openOnly: z.boolean().optional().describe("Only quotes not yet won/lost (IsClosed = false)."),
        minValueExTax: z.number().optional().describe("Only quotes worth at least this much (ex tax)."),
        ...dateRange,
        filters: filtersArg,
        columns: columnsArg,
        orderby: z.string().optional().describe("Default '-DateIssued'."),
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) => {
      const q = listQuery(ctx, args, { columns: QUOTE_COLUMNS, orderby: "-DateIssued" }, {
        Name: wildcard(args.name),
        "Customer.ID": args.customerId,
        "Site.ID": args.siteId,
        Stage: args.stage?.length ? `in(${args.stage.join(",")})` : undefined,
        IsClosed: args.openOnly ? false : undefined,
        "Total.ExTax": args.minValueExTax !== undefined ? `ge(${args.minValueExTax})` : undefined,
        DateIssued: dateFilter(args.dateFrom, args.dateTo),
      });
      return ok(pageResult(await ctx.client.list("quotes/", q)), ctx.cfg);
    }),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get quote details",
      description: "Full details of one quote, optionally with its sections/cost centres and notes.",
      inputSchema: {
        quoteId: z.number().int(),
        include: z.array(z.enum(["costCenters", "notes"])).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ quoteId, include = [] }) => {
      const out: Record<string, unknown> = { quote: await ctx.client.get(`quotes/${quoteId}`) };
      const tasks: Array<Promise<void>> = [];
      if (include.includes("costCenters")) {
        tasks.push(
          (async () => {
            const sections = await ctx.client.get<Array<{ ID: number }>>(`quotes/${quoteId}/sections/`);
            out.sections = await Promise.all(
              (sections ?? []).map(async (s) => ({
                ...s,
                costCenters: await ctx.client.get(`quotes/${quoteId}/sections/${s.ID}/costCenters/`),
              })),
            );
          })(),
        );
      }
      if (include.includes("notes")) tasks.push(ctx.client.get(`quotes/${quoteId}/notes/`).then((n) => void (out.notes = n)));
      await Promise.all(tasks);
      return ok(out, ctx.cfg);
    }),
  );

  server.registerTool(
    "quote_pipeline",
    {
      title: "Quote pipeline summary",
      description:
        "Totals of quotes issued in a date range, grouped by stage, with counts and ex-tax values. Good for 'how much have we quoted / won this month'.",
      inputSchema: { ...dateRange, customerId: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ dateFrom, dateTo, customerId }) => {
      const { rows, truncated, totalRows } = await ctx.client.listAll<Record<string, any>>(
        "quotes/",
        {
          DateIssued: dateFilter(dateFrom, dateTo),
          "Customer.ID": customerId,
          columns: "ID,Stage,IsClosed,Total",
        },
        5000,
      );
      const byStage: Record<string, { count: number; valueExTax: number }> = {};
      for (const r of rows) {
        const key = `${r.Stage ?? "Unknown"}${r.IsClosed ? " (closed)" : ""}`;
        byStage[key] ??= { count: 0, valueExTax: 0 };
        byStage[key].count++;
        byStage[key].valueExTax += typeof r.Total?.ExTax === "number" ? r.Total.ExTax : 0;
      }
      for (const v of Object.values(byStage)) v.valueExTax = Math.round(v.valueExTax * 100) / 100;
      return ok(
        {
          period: { from: dateFrom ?? "any", to: dateTo ?? "any" },
          quotes: totalRows,
          byStage,
          ...(truncated ? { warning: `Only the first ${rows.length} quotes were counted; narrow the date range.` } : {}),
        },
        ctx.cfg,
      );
    }),
  );
}
