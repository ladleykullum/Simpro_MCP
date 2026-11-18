#!/usr/bin/env node
/**
 * Entry point. SIMPRO_TRANSPORT=stdio (default) runs locally for Claude
 * Desktop; SIMPRO_TRANSPORT=http runs the hosted connector.
 * Never write to stdout here: in stdio mode it carries the MCP protocol.
 */
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadDotEnv, PROJECT_ROOT, type Config } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { WriteGuard } from "./safety.js";
import { SimproClient } from "./simpro/client.js";
import { localTokenProvider } from "./simpro/local.js";
import { sharedLimiter } from "./simpro/rateLimiter.js";
import { buildServer, VERSION } from "./server.js";

async function runStdio(cfg: Config): Promise<void> {
  const client = new SimproClient({
    baseUrl: cfg.baseUrl,
    companyId: cfg.companyId,
    tokens: localTokenProvider(cfg),
    limiter: sharedLimiter(cfg.requestsPerSecond),
  });
  const guard = new WriteGuard(cfg.writeMode, cfg.allowDelete, cfg.secret, join(cfg.stateDir, "audit.log"));
  const server = buildServer(client, guard, cfg);
  await server.connect(new StdioServerTransport());
  console.error(`[simpro-mcp] v${VERSION} ready (stdio, ${cfg.baseUrl}, writes: ${cfg.writeMode})`);
}

async function runHttp(cfg: Config): Promise<void> {
  const { app } = createHttpApp(cfg);
  console.error(`[simpro-mcp] binding ${cfg.host}:${cfg.port}`);
  const server = app.listen(cfg.port, cfg.host, () =>
    console.error(`[simpro-mcp] v${VERSION} listening on ${cfg.host}:${cfg.port}; connector URL: ${cfg.publicUrl}/mcp`),
  );
  server.on("error", (err) => {
    console.error(`[simpro-mcp] failed to start: ${err.message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  loadDotEnv(process.env.SIMPRO_ENV_FILE ?? join(PROJECT_ROOT, ".env"));
  const cfg = loadConfig();
  if (cfg.transport === "http") await runHttp(cfg);
  else await runStdio(cfg);
}

main().catch((err) => {
  console.error(`[simpro-mcp] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
