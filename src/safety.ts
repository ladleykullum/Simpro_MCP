/**
 * Guard for every write to Simpro.
 *
 *  read_only : writes are refused.
 *  confirm   : (default) the first call returns a preview and a confirmation
 *              token; the write only runs when the same call is repeated with
 *              that token. Tokens are signed and bound to the exact method,
 *              path and body, and expire after 10 minutes.
 *  auto      : writes run straight away.
 *
 * DELETE is refused unless SIMPRO_ALLOW_DELETE=true, in every mode.
 * Every executed write is written to an audit log.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WriteMode } from "./config.js";
import { normalizePath, type HttpMethod } from "./simpro/client.js";

const TOKEN_TTL_MS = 10 * 60_000;

export type WriteMethod = Exclude<HttpMethod, "GET">;

export type GuardDecision =
  | { action: "execute" }
  | { action: "preview"; confirmToken: string; expiresAt: string }
  | { action: "refuse"; reason: string };

/** JSON with sorted keys, so the same body always signs the same way. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

export interface AuditEntry {
  method: WriteMethod;
  path: string;
  body?: unknown;
  user?: string;
  status?: number;
  resourceId?: string;
  error?: string;
}

export class WriteGuard {
  private readonly key: Buffer;

  constructor(
    readonly mode: WriteMode,
    readonly allowDelete: boolean,
    secret?: string,
    private readonly auditPath?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = secret ? Buffer.from(secret) : randomBytes(32);
  }

  private sign(method: string, path: string, body: unknown, exp: number, user = ""): string {
    return createHmac("sha256", this.key)
      .update([method, normalizePath(path), stableStringify(body), exp, user].join("\n"))
      .digest("base64url");
  }

  check(method: WriteMethod, path: string, body: unknown, confirmToken?: string, user?: string): GuardDecision {
    if (this.mode === "read_only") {
      return { action: "refuse", reason: "This server is in read-only mode (SIMPRO_WRITE_MODE=read_only). No changes can be made." };
    }
    if (method === "DELETE" && !this.allowDelete) {
      return {
        action: "refuse",
        reason: "Deleting is turned off (set SIMPRO_ALLOW_DELETE=true to enable). Consider archiving or changing the status instead.",
      };
    }
    if (this.mode === "auto") return { action: "execute" };

    if (confirmToken) {
      const [expStr, sig] = confirmToken.split(".");
      const exp = Number(expStr);
      if (!Number.isFinite(exp) || !sig) return { action: "refuse", reason: "Confirmation token is malformed." };
      if (this.now() > exp) return { action: "refuse", reason: "Confirmation token has expired. Preview the change again." };
      const expected = Buffer.from(this.sign(method, path, body, exp, user));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        return {
          action: "refuse",
          reason: "Confirmation token does not match this exact change (method, path and body must be identical to the preview).",
        };
      }
      return { action: "execute" };
    }

    const exp = this.now() + TOKEN_TTL_MS;
    return {
      action: "preview",
      confirmToken: `${exp}.${this.sign(method, path, body, exp, user)}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  audit(entry: AuditEntry): void {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry });
    console.error(`[simpro-mcp] write ${line}`);
    if (!this.auditPath) return;
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      appendFileSync(this.auditPath, line + "\n");
    } catch (err) {
      console.error(`[simpro-mcp] could not write audit log: ${(err as Error).message}`);
    }
  }
}
