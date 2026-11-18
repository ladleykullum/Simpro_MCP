import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  columnsArg,
  confirmArg,
  dateFilter,
  dateRange,
  filtersArg,
  guardedWrite,
  listQuery,
  ok,
  pageResult,
  paging,
  safe,
  wildcard,
  type ToolContext,
} from "./context.js";

const JOB_STAGES = ["Pending", "Progress", "Complete", "Invoiced", "Archived"] as const;
const JOB_COLUMNS = ["ID", "Name", "Customer", "Site", "Stage", "Status", "DateIssued", "Total"];
const SCHEDULE_COLUMNS = ["ID", "Type", "Reference", "Staff", "Date", "Blocks"];

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "find_jobs",
    {
      title: "Find jobs",
      description:
        "Search jobs. Filter by name text, customer, site, stage and issue date. Returns one page; ask for the next with `page`. " +
        "Job stages: Pending, Progress, Complete, Invoiced, Archived.",
      inputSchema: {
        name: z.string().optional().describe("Text the job name contains."),
        customerId: z.number().int().optional(),
        siteId: z.number().int().optional(),
        stage: z.array(z.enum(JOB_STAGES)).optional().describe("One or more stages."),
        ...dateRange,
        filters: filtersArg,
        columns: columnsArg,
        orderby: z.string().optional().describe("Sort field; prefix '-' for descending. Default '-DateIssued' (newest first)."),
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) => {
      const q = listQuery(ctx, args, { columns: JOB_COLUMNS, orderby: "-DateIssued" }, {
        Name: wildcard(args.name),
        "Customer.ID": args.customerId,
        "Site.ID": args.siteId,
        Stage: args.stage?.length ? `in(${args.stage.join(",")})` : undefined,
        DateIssued: dateFilter(args.dateFrom, args.dateTo),
      });
      return ok(pageResult(await ctx.client.list("jobs/", q)), ctx.cfg);
    }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job details",
      description:
        "Full details of one job, optionally with its cost centres, notes, scheduled bookings and invoices in one go.",
      inputSchema: {
        jobId: z.number().int(),
        include: z
          .array(z.enum(["costCenters", "notes", "schedule", "invoices"]))
          .optional()
          .describe("Extra related data to fetch."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ jobId, include = [] }) => {
      const job = await ctx.client.get(`jobs/${jobId}`);
      const out: Record<string, unknown> = { job };
      const tasks: Array<Promise<void>> = [];
      if (include.includes("costCenters")) {
        tasks.push(
          (async () => {
            const sections = await ctx.client.get<Array<{ ID: number; Name?: string }>>(`jobs/${jobId}/sections/`);
            out.sections = await Promise.all(
              (sections ?? []).map(async (s) => ({
                ...s,
                costCenters: await ctx.client.get(`jobs/${jobId}/sections/${s.ID}/costCenters/`),
              })),
            );
          })(),
        );
      }
      if (include.includes("notes")) {
        tasks.push(ctx.client.get(`jobs/${jobId}/notes/`).then((n) => void (out.notes = n)));
      }
      if (include.includes("schedule")) {
        tasks.push(
          ctx.client
            .listAll("schedules/", { JobID: jobId, columns: SCHEDULE_COLUMNS.join(","), orderby: "Date" }, 500)
            .then((s) => void (out.schedule = s.rows)),
        );
      }
      if (include.includes("invoices")) {
        tasks.push(
          ctx.client
            .listAll("invoices/", { "Jobs.ID": jobId, columns: "ID,Type,Stage,DateIssued,DueDate,Total,IsPaid" }, 200)
            .then((i) => void (out.invoices = i.rows)),
        );
      }
      await Promise.all(tasks);
      return ok(out, ctx.cfg);
    }),
  );

  server.registerTool(
    "job_financials",
    {
      title: "Job financials",
      description:
        "Money summary for a job: contract value, costs and margin as Simpro reports them, plus what has been invoiced and what is still unpaid.",
      inputSchema: { jobId: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ jobId }) => {
      const [job, invoices] = await Promise.all([
        ctx.client.get<Record<string, any>>(`jobs/${jobId}`, { columns: "ID,Name,Stage,Customer,Total,Totals" }),
        ctx.client.listAll<Record<string, any>>(
          "invoices/",
          { "Jobs.ID": jobId, columns: "ID,Type,Stage,DateIssued,DueDate,Total,IsPaid" },
          500,
        ),
      ]);
      let invoicedIncTax = 0;
      let unpaidIncTax = 0;
      for (const inv of invoices.rows) {
        const amount = num(inv.Total?.IncTax) ?? 0;
        invoicedIncTax += amount;
        if (inv.IsPaid === false) unpaidIncTax += num(inv.Total?.BalanceDue) ?? amount;
      }
      const contractExTax = num(job?.Total?.ExTax);
      const contractIncTax = num(job?.Total?.IncTax);
      const round = (n: number) => Math.round(n * 100) / 100;
      return ok(
        {
          job: { ID: job?.ID, Name: job?.Name, Stage: job?.Stage, Customer: job?.Customer },
          contract: job?.Total,
          simproTotals: job?.Totals,
          invoicing: {
            invoiceCount: invoices.rows.length,
            invoicedIncTax: round(invoicedIncTax),
            unpaidIncTax: round(unpaidIncTax),
            leftToInvoiceIncTax: contractIncTax !== undefined ? round(contractIncTax - invoicedIncTax) : undefined,
            percentInvoiced:
              contractIncTax ? `${Math.round((invoicedIncTax / contractIncTax) * 100)}%` : undefined,
          },
          notes:
            "simproTotals holds Simpro's own cost/margin figures (estimate vs actual where available). " +
            (contractExTax === undefined ? "No contract total was returned for this job." : ""),
          invoices: invoices.rows,
        },
        ctx.cfg,
      );
    }),
  );

  server.registerTool(
    "find_schedule",
    {
      title: "Find scheduled bookings",
      description:
        "Who is booked where and when. Filter by date range, staff member, or job. Each booking has a Reference like '1234-56' (job-costcentre) and time Blocks.",
      inputSchema: {
        ...dateRange,
        staffId: z.number().int().optional().describe("Employee/contractor ID (see list_staff)."),
        jobId: z.number().int().optional(),
        filters: filtersArg,
        columns: columnsArg,
        ...paging,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) => {
      const q = listQuery(ctx, args, { columns: SCHEDULE_COLUMNS, orderby: "Date" }, {
        Date: dateFilter(args.dateFrom, args.dateTo),
        "Staff.ID": args.staffId,
        JobID: args.jobId,
      });
      return ok(pageResult(await ctx.client.list("schedules/", q)), ctx.cfg);
    }),
  );

  server.registerTool(
    "list_staff",
    {
      title: "List staff",
      description: "Employees (and optionally contractors) with their IDs, for use with find_schedule and filters.",
      inputSchema: {
        name: z.string().optional().describe("Text the name contains."),
        includeContractors: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ name, includeContractors }) => {
      const q = { Name: wildcard(name), columns: "ID,Name" };
      const employees = await ctx.client.listAll("employees/", q, 1000);
      const out: Record<string, unknown> = { employees: employees.rows };
      if (includeContractors) out.contractors = (await ctx.client.listAll("contractors/", q, 1000)).rows;
      return ok(out, ctx.cfg);
    }),
  );

  server.registerTool(
    "add_note",
    {
      title: "Add a note to a job or quote",
      description:
        "Adds a note to a job or quote. This changes Simpro data, so the first call returns a preview and a token; " +
        "confirm with the user, then call again with the token.",
      inputSchema: {
        entity: z.enum(["job", "quote"]),
        id: z.number().int(),
        subject: z.string().min(1).max(200),
        note: z.string().min(1).describe("Note text. Line breaks are kept."),
        confirmToken: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ entity, id, subject, note, confirmToken }) => {
      const path = `${entity === "job" ? "jobs" : "quotes"}/${id}/notes/`;
      const body = { Subject: subject, Note: note.replace(/\n/g, "<br>") };
      return guardedWrite(ctx, "POST", path, body, confirmToken, `Add note "${subject}" to ${entity} ${id}`);
    }),
  );
}
