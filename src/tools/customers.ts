import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SimproError } from "../simpro/client.js";
import { columnsArg, ok, pageResult, paging, safe, wildcard, type ToolContext } from "./context.js";

type CustomerKind = "companies" | "individuals";

export function registerCustomerTools(server: McpServer, ctx: ToolContext): void {
  /** Simpro splits customers into companies and individuals; find which one an ID is. */
  async function loadCustomer(id: number, columns?: string): Promise<{ kind: CustomerKind; customer: unknown }> {
    try {
      return { kind: "companies", customer: await ctx.client.get(`customers/companies/${id}`, { columns }) };
    } catch (err) {
      if (!(err instanceof SimproError) || err.status !== 404) throw err;
    }
    return { kind: "individuals", customer: await ctx.client.get(`customers/individuals/${id}`, { columns }) };
  }

  server.registerTool(
    "find_customers",
    {
      title: "Find customers",
      description:
        "Search customers by name. Looks at both company customers (by company name) and individual customers (by first or last name).",
      inputSchema: {
        name: z.string().min(1).describe("Text the customer's name contains."),
        type: z.enum(["any", "company", "individual"]).optional(),
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ name, type = "any", page, pageSize }) => {
      const w = wildcard(name);
      const size = pageSize ?? ctx.cfg.defaultPageSize;
      const results: Record<string, unknown> = {};
      const jobs: Array<Promise<void>> = [];
      if (type !== "individual") {
        jobs.push(
          ctx.client
            .list("customers/companies/", { CompanyName: w, columns: "ID,CompanyName,Phone,Email,Address", page, pageSize: size })
            .then((p) => void (results.companies = pageResult(p))),
        );
      }
      if (type !== "company") {
        const cols = "ID,GivenName,FamilyName,Phone,CellPhone,Email,Address";
        // Two queries (first OR last name); Simpro's "any" match would also OR any other filters.
        jobs.push(
          Promise.all([
            ctx.client.list<Record<string, unknown>>("customers/individuals/", { FamilyName: w, columns: cols, page, pageSize: size }),
            ctx.client.list<Record<string, unknown>>("customers/individuals/", { GivenName: w, columns: cols, page, pageSize: size }),
          ]).then(([a, b]) => {
            const seen = new Set<unknown>();
            results.individuals = [...a.rows, ...b.rows].filter((r) => !seen.has(r.ID) && seen.add(r.ID));
          }),
        );
      }
      await Promise.all(jobs);
      return ok(results, ctx.cfg);
    }),
  );

  server.registerTool(
    "customer_overview",
    {
      title: "Customer overview",
      description:
        "Everything about one customer in one call: details, contacts, sites, open jobs, open quotes and unpaid invoices.",
      inputSchema: { customerId: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ customerId }) => {
      const { kind, customer } = await loadCustomer(customerId);
      const byCustomer = { "Customer.ID": customerId };
      const [contacts, sites, jobs, quotes, invoices] = await Promise.allSettled([
        ctx.client.listAll(`customers/${kind}/${customerId}/contacts/`, { columns: "ID,GivenName,FamilyName,Position,Email,WorkPhone,CellPhone" }, 200),
        ctx.client.listAll("sites/", { "Customers.ID": customerId, columns: "ID,Name,Address" }, 200),
        ctx.client.listAll("jobs/", { ...byCustomer, Stage: "in(Pending,Progress,Complete)", columns: "ID,Name,Site,Stage,Status,DateIssued,Total" }, 200),
        ctx.client.listAll("quotes/", { ...byCustomer, IsClosed: false, columns: "ID,Name,Stage,Status,DateIssued,DueDate,Total" }, 200),
        ctx.client.listAll("invoices/", { ...byCustomer, IsPaid: false, columns: "ID,DateIssued,DueDate,Total,Jobs" }, 200),
      ]);
      const val = (r: PromiseSettledResult<{ rows: unknown[] }>) =>
        r.status === "fulfilled" ? r.value.rows : { error: (r.reason as Error).message };
      return ok(
        {
          customerType: kind === "companies" ? "company" : "individual",
          customer,
          contacts: val(contacts),
          sites: val(sites),
          openJobs: val(jobs),
          openQuotes: val(quotes),
          unpaidInvoices: val(invoices),
        },
        ctx.cfg,
      );
    }),
  );

  server.registerTool(
    "find_sites",
    {
      title: "Find sites",
      description: "Search sites (job locations) by name or street address, or list a customer's sites.",
      inputSchema: {
        name: z.string().optional().describe("Text the site name contains."),
        address: z.string().optional().describe("Text the street address contains."),
        customerId: z.number().int().optional(),
        columns: columnsArg,
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ name, address, customerId, columns, page, pageSize }) => {
      const p = await ctx.client.list("sites/", {
        Name: wildcard(name),
        "Address.Address": wildcard(address),
        "Customers.ID": customerId,
        columns: (columns?.length ? columns : ["ID", "Name", "Address", "Customers"]).join(","),
        page,
        pageSize: pageSize ?? ctx.cfg.defaultPageSize,
      });
      return ok(pageResult(p), ctx.cfg);
    }),
  );

  server.registerTool(
    "get_site",
    {
      title: "Get site details",
      description: "Full details of one site, with optional recent jobs at that site.",
      inputSchema: { siteId: z.number().int(), includeJobs: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ siteId, includeJobs }) => {
      const out: Record<string, unknown> = { site: await ctx.client.get(`sites/${siteId}`) };
      if (includeJobs) {
        out.recentJobs = (
          await ctx.client.list("jobs/", {
            "Site.ID": siteId,
            columns: "ID,Name,Customer,Stage,DateIssued,Total",
            orderby: "-DateIssued",
            pageSize: 20,
          })
        ).rows;
      }
      return ok(out, ctx.cfg);
    }),
  );
}
