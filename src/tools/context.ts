import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { clean, toText } from "../format.js";
import type { WriteGuard, WriteMethod } from "../safety.js";
import { SimproError, type Page, type Query, type SimproClient } from "../simpro/client.js";

export interface ToolContext {
  client: SimproClient;
  guard: WriteGuard;
  cfg: Config;
  /** Who is calling (hosted mode), for the audit log. */
  user?: string;
}

export function ok(data: unknown, cfg: Config): CallToolResult {
  return { content: [{ type: "text", text: toText(clean(data) ?? { success: true }, cfg.maxResultChars) }] };
}

export function fail(err: unknown): CallToolResult {
  const message =
    err instanceof SimproError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wraps a handler so any thrown error becomes a readable tool error. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export function pageResult(p: Page, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    rows: p.rows,
    pagination: {
      page: p.page,
      pageSize: p.pageSize,
      totalRows: p.totalRows,
      totalPages: p.totalPages,
      ...(p.page < p.totalPages ? { next: `call again with page: ${p.page + 1}` } : {}),
    },
  };
}

// ---------- shared input schemas ----------

export const paging = {
  page: z.number().int().min(1).optional().describe("Page number, starting at 1."),
  pageSize: z.number().int().min(1).max(250).optional().describe("Rows per page (max 250)."),
};

export const columnsArg = z
  .array(z.string())
  .optional()
  .describe("Fields to return, e.g. ['ID','Name','Customer','Total']. Nested fields allowed. Omit for the default set.");

export const filtersArg = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe(
    "Extra Simpro filters as column → value. Supports wildcards ('%smith%'), and operators: " +
      "gt(x), ge(x), lt(x), le(x), ne(x), between(a,b), in(a,b,c). Nested columns use dots, e.g. {'Customer.ID': 12}.",
  );

export const dateRange = {
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date, YYYY-MM-DD (inclusive)."),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date, YYYY-MM-DD (inclusive)."),
};

// ---------- query helpers ----------

/** Builds a Simpro date filter value from an optional range. */
export function dateFilter(from?: string, to?: string): string | undefined {
  if (from && to) return `between(${from},${to})`;
  if (from) return `ge(${from})`;
  if (to) return `le(${to})`;
  return undefined;
}

/** Simpro has no free-text search; match with a wildcard on one column. */
export function wildcard(text?: string): string | undefined {
  const t = text?.replace(/%/g, "").trim();
  return t ? `%${t}%` : undefined;
}

export function listQuery(
  ctx: ToolContext,
  args: { page?: number; pageSize?: number; columns?: string[]; filters?: Record<string, unknown>; orderby?: string },
  defaults: { columns: string[]; orderby?: string },
  filters: Query = {},
): Query {
  const q: Query = {
    ...filters,
    ...((args.filters ?? {}) as Query),
    columns: (args.columns?.length ? args.columns : defaults.columns).join(","),
    page: args.page ?? 1,
    pageSize: args.pageSize ?? ctx.cfg.defaultPageSize,
  };
  const order = args.orderby ?? defaults.orderby;
  if (order) q.orderby = order;
  // Column filters are ANDed by default. Simpro's `search` param only takes
  // "all"/"any" (never keywords), so it is left alone here.
  return q;
}

/** Runs a write through the safety guard. Used by every tool that changes data. */
export async function guardedWrite(
  ctx: ToolContext,
  method: WriteMethod,
  path: string,
  body: unknown,
  confirmToken: string | undefined,
  summary: string,
): Promise<CallToolResult> {
  const decision = ctx.guard.check(method, path, body, confirmToken, ctx.user);
  if (decision.action === "refuse") return fail(decision.reason);
  if (decision.action === "preview") {
    return ok(
      {
        status: "NOT DONE YET: confirmation needed",
        change: summary,
        request: { method, path, body },
        nextStep:
          "Show this change to the user in plain words and ask them to approve it. " +
          "If they approve, call this tool again with exactly the same arguments plus confirmToken.",
        confirmToken: decision.confirmToken,
        expiresAt: decision.expiresAt,
      },
      ctx.cfg,
    );
  }
  try {
    const res = await ctx.client.write(method, path, body);
    ctx.guard.audit({ method, path, body, user: ctx.user, status: res.status, resourceId: res.resourceId });
    return ok({ status: "done", change: summary, httpStatus: res.status, resourceId: res.resourceId, result: res.data }, ctx.cfg);
  } catch (err) {
    ctx.guard.audit({ method, path, body, user: ctx.user, error: (err as Error).message });
    return fail(err);
  }
}

export const confirmArg = z
  .string()
  .optional()
  .describe("Leave empty the first time; you'll get a preview and a token. Pass the token only after the user approves.");
