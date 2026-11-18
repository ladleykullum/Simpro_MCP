import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder (one level above dist/). Paths default to here, not to the
 * current directory, because Claude Desktop starts the server from elsewhere. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How writes (POST/PUT/PATCH/DELETE) to Simpro are handled. */
export type WriteMode =
  /** No writes at all. */
  | "read_only"
  /** Every write is previewed first and only runs when called again with the confirmation token. (default) */
  | "confirm"
  /** Writes run straight away. */
  | "auto";

export type AuthMode = "api_key" | "client_credentials" | "authorization_code";

export interface Config {
  transport: "stdio" | "http";
  /** e.g. https://yourbuild.simprosuite.com (no trailing slash, no /api) */
  baseUrl: string;
  companyId: number;

  authMode: AuthMode;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl: string;
  authorizeUrl: string;
  /** Port for the local browser login callback (stdio + authorization_code). */
  redirectPort: number;
  /** Where the local refresh token is cached. */
  tokenCachePath: string;

  writeMode: WriteMode;
  allowDelete: boolean;
  /** Secret used to sign confirmation tokens and hosted-mode access tokens. */
  secret?: string;

  defaultPageSize: number;
  maxResultChars: number;
  requestsPerSecond: number;

  // Hosted (http) mode
  port: number;
  host: string;
  publicUrl?: string;
  stateDir: string;
}

/** Minimal .env loader: KEY=VALUE lines, existing environment wins. */
export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? Math.trunc(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const transport = (env.SIMPRO_TRANSPORT ?? "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`SIMPRO_TRANSPORT must be "stdio" or "http" (got "${transport}")`);
  }

  const baseUrl = (env.SIMPRO_BASE_URL ?? "").trim().replace(/\/+$/, "").replace(/\/api(\/v1\.0)?$/, "");
  if (!baseUrl) throw new Error("SIMPRO_BASE_URL is required, e.g. https://yourbuild.simprosuite.com");
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("SIMPRO_BASE_URL must start with https://");

  const apiKey = env.SIMPRO_API_KEY || undefined;
  const clientId = env.SIMPRO_CLIENT_ID || undefined;
  const clientSecret = env.SIMPRO_CLIENT_SECRET || undefined;

  let authMode = (env.SIMPRO_AUTH_MODE || "") as AuthMode | "";
  if (!authMode) {
    if (transport === "http") authMode = "authorization_code";
    else if (clientId && clientSecret) authMode = "authorization_code";
    else authMode = "api_key";
  }
  if (!["api_key", "client_credentials", "authorization_code"].includes(authMode)) {
    throw new Error(`SIMPRO_AUTH_MODE must be api_key, client_credentials or authorization_code`);
  }
  if (authMode === "api_key" && !apiKey) {
    throw new Error("Set SIMPRO_API_KEY, or SIMPRO_CLIENT_ID + SIMPRO_CLIENT_SECRET for OAuth.");
  }
  if (authMode !== "api_key" && (!clientId || !clientSecret)) {
    throw new Error(`SIMPRO_AUTH_MODE=${authMode} needs SIMPRO_CLIENT_ID and SIMPRO_CLIENT_SECRET.`);
  }
  if (transport === "http") {
    if (authMode !== "authorization_code") {
      throw new Error(
        "Hosted (http) mode signs each person in with their own Simpro login, so it needs " +
          "SIMPRO_AUTH_MODE=authorization_code (the default). A shared API key is never used over HTTP.",
      );
    }
    if (!env.PUBLIC_URL) throw new Error("PUBLIC_URL is required in http mode, e.g. https://simpro-mcp.example.com");
  }

  const writeMode = (env.SIMPRO_WRITE_MODE ?? "confirm").toLowerCase() as WriteMode;
  if (!["read_only", "confirm", "auto"].includes(writeMode)) {
    throw new Error(`SIMPRO_WRITE_MODE must be read_only, confirm or auto`);
  }

  const stateDir = resolve(PROJECT_ROOT, env.SIMPRO_STATE_DIR || (existsSync("/data") ? "/data" : "data"));

  return {
    transport,
    baseUrl,
    companyId: int(env.SIMPRO_COMPANY_ID, 0),
    authMode,
    apiKey,
    clientId,
    clientSecret,
    tokenUrl: env.SIMPRO_TOKEN_URL || `${baseUrl}/oauth2/token`,
    authorizeUrl: env.SIMPRO_AUTH_URL || `${baseUrl}/oauth2/login`,
    redirectPort: int(env.SIMPRO_AUTH_REDIRECT_PORT, 8237),
    tokenCachePath: resolve(PROJECT_ROOT, env.SIMPRO_TOKEN_CACHE || ".simpro-tokens.json"),
    writeMode,
    allowDelete: bool(env.SIMPRO_ALLOW_DELETE, false),
    secret: env.SIMPRO_SECRET || undefined,
    defaultPageSize: Math.min(Math.max(int(env.SIMPRO_PAGE_SIZE, 30), 1), 250),
    maxResultChars: int(env.SIMPRO_MAX_RESULT_CHARS, 60_000),
    requestsPerSecond: Math.min(Math.max(int(env.SIMPRO_RATE_LIMIT, 8), 1), 10),
    port: int(env.PORT, 3000),
    host: env.HOST || "0.0.0.0",
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, ""),
    stateDir,
  };
}
