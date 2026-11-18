#!/usr/bin/env node
/**
 * `npm run check`: runs every lookup tool once against the Simpro account in
 * .env and reports what works. Read-only: it never changes anything in Simpro.
 */
import { join } from "node:path";
import { loadConfig, loadDotEnv, PROJECT_ROOT } from "./config.js";
import { formatResults, runChecks } from "./liveCheck.js";
import { SimproClient } from "./simpro/client.js";
import { localTokenProvider } from "./simpro/local.js";
import { sharedLimiter } from "./simpro/rateLimiter.js";

loadDotEnv(process.env.SIMPRO_ENV_FILE ?? join(PROJECT_ROOT, ".env"));
const cfg = loadConfig({ ...process.env, SIMPRO_TRANSPORT: "stdio", SIMPRO_WRITE_MODE: "read_only" });
const client = new SimproClient({
  baseUrl: cfg.baseUrl,
  companyId: cfg.companyId,
  tokens: localTokenProvider(cfg),
  limiter: sharedLimiter(cfg.requestsPerSecond),
});

console.log(`Checking ${cfg.baseUrl} (company ${cfg.companyId}), read-only...\n`);
runChecks(client, cfg)
  .then((results) => {
    console.log(formatResults(results));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  })
  .catch((err) => {
    console.error(`Check failed to run: ${(err as Error).message}`);
    process.exit(1);
  });
