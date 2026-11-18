import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { confirmArg, guardedWrite, ok, pageResult, safe, type ToolContext } from "./context.js";

export const API_GUIDE = `# Simpro API quick reference

Paths are relative to /api/v1.0/companies/{companyId}/. Collections end with "/", single records don't:
  jobs/        jobs/123        jobs/123/sections/        jobs/123/sections/4/costCenters/

## Common endpoints
- Jobs: jobs/  · jobs/{id}/notes/ · jobs/{id}/sections/{sid}/costCenters/{ccid}/ (materials: .../catalogs/, labour: .../labor/, one-offs: .../oneOffs/)
- Quotes: quotes/  · quotes/{id}/notes/ · quotes/{id}/sections/...
- Customer invoices: invoices/  · Supplier invoices: vendorReceipts/ · Credit notes: creditNotes/
- Customers: customers/companies/ · customers/individuals/ · .../{id}/contacts/
- Sites: sites/ (filter by Customers.ID; there is no customers/{id}/sites/)
- Schedules: schedules/ (filter by JobID, Staff.ID, Date) · Activities: activitySchedules/
- Staff: employees/ · contractors/ · Leads: leads/ · Assets: customerAssets/ (under sites)
- Catalogue: catalogs/ · Pre-builds: prebuilds/ · Purchase orders: vendorOrders/ · Suppliers: vendors/
- Setup lists: setup/statusCodes/projects/ (job/quote statuses), setup/taxCodes/, setup/costCenters/
- Logs: logs/jobs/ · logs/quotes/ · logs/customerInvoices/ (filter Message with %text%)

## Query parameters
- columns=ID,Name,Customer        choose fields (nested allowed: Total.ExTax)
- pageSize (max 250), page
- orderby=-DateIssued              "-" for descending
- Filters are just column=value:   Stage=Progress   Customer.ID=12   Name=%smith%  (%=wildcard)
- Operators: gt() ge() lt() le() ne() between(a,b) in(a,b,c)   e.g. DateIssued=between(2026-01-01,2026-01-31)
- search=any makes filters OR instead of AND. search never takes keywords.

## Writes
- POST to a collection creates; PATCH to a record updates the fields you send; DELETE removes.
- Simpro often answers 204 with no body; the new ID comes back as resourceId.
- Bulk creates go to .../multiple/ with an array; each item gets its own status.
- Records open in Simpro by a person are locked (422 "currently locked by ..."). Ask them to close it, then retry.
- Job/quote Description is HTML: use <p>, <br>, <ul><li>.
- Job stages: Pending, Progress, Complete, Invoiced, Archived. Quote stages: InProgress, Complete, Approved, Archived.
`;

export function registerGenericTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "simpro_api_guide",
    {
      title: "Simpro API reference",
      description:
        "Cheat sheet of Simpro endpoints, filters and write rules. Read this before using simpro_get or simpro_write for something the other tools don't cover.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: API_GUIDE }] }),
  );

  server.registerTool(
    "simpro_get",
    {
      title: "Read any Simpro endpoint",
      description:
        "GET any Simpro API path, for data the dedicated tools don't cover. Path is relative, e.g. 'jobs/123/sections/' or 'employees/'. " +
        "For collections, pass query.columns to keep results small. See simpro_api_guide.",
      inputSchema: {
        path: z.string().min(1),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query parameters: columns, page, pageSize, orderby, and column filters."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path, query = {} }) => {
      const isCollection = !/\/\d+\/?$/.test(path.split("?")[0]);
      if (isCollection) {
        const p = await ctx.client.list(path, { pageSize: ctx.cfg.defaultPageSize, ...query });
        return ok(pageResult(p), ctx.cfg);
      }
      return ok(await ctx.client.get(path, query), ctx.cfg);
    }),
  );

  server.registerTool(
    "simpro_write",
    {
      title: "Change data in Simpro",
      description:
        "Create (POST), update (PATCH/PUT) or delete (DELETE) anything in Simpro. Changes real data. " +
        "Depending on settings, the first call returns a preview and confirmToken: describe the change to the user in plain words, " +
        "get their OK, then call again with identical arguments plus confirmToken. Deleting may be disabled. See simpro_api_guide.",
      inputSchema: {
        method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
        path: z.string().min(1).describe("e.g. 'jobs/123' to update a job, 'quotes/' to create a quote."),
        body: z.unknown().optional().describe("JSON body. For PATCH send only the fields to change."),
        summary: z.string().min(3).describe("One plain-English sentence describing the change, shown to the user."),
        confirmToken: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ method, path, body, summary, confirmToken }) =>
      guardedWrite(ctx, method, path, body, confirmToken, summary),
    ),
  );
}
