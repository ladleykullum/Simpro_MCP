import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { WriteGuard } from "./safety.js";
import type { SimproClient } from "./simpro/client.js";
import type { ToolContext } from "./tools/context.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerQuoteTools } from "./tools/quotes.js";

export const VERSION = "0.1.0";

function instructions(cfg: Config): string {
  const writes =
    cfg.writeMode === "read_only"
      ? "This server is READ-ONLY: no changes can be made to Simpro."
      : cfg.writeMode === "confirm"
        ? "Changes need the user's approval: write tools first return a preview and a confirmToken. Explain the change in plain words, wait for the user to say yes, then repeat the call with the token. Never confirm on the user's behalf."
        : "Writes run immediately and cannot be undone. Double-check IDs and ask the user before any change.";
  return [
    "Tools for this business's Simpro account (job management: jobs, scheduling, quotes, invoices, customers, sites).",
    "Prefer the dedicated tools. For anything else, read simpro_api_guide, then use simpro_get / simpro_write.",
    "Results are paged: check pagination.totalRows before saying how many there are, and fetch more pages when needed.",
    "Money: Total.ExTax / Total.IncTax. Dates are YYYY-MM-DD.",
    writes,
    cfg.allowDelete ? "" : "Deleting is disabled.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildServer(client: SimproClient, guard: WriteGuard, cfg: Config, user?: string): McpServer {
  const server = new McpServer(
    { name: "simpro-mcp", version: VERSION },
    { instructions: instructions(cfg), capabilities: { tools: {} } },
  );
  const ctx: ToolContext = { client, guard, cfg, user };
  registerJobTools(server, ctx);
  registerQuoteTools(server, ctx);
  registerInvoiceTools(server, ctx);
  registerCustomerTools(server, ctx);
  registerGenericTools(server, ctx);
  return server;
}
