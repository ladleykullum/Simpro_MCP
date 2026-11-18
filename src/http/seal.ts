/**
 * AES-256-GCM sealing. Hosted mode hands Claude tokens that carry the user's
 * Simpro tokens encrypted inside, so the server keeps no token database.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string | Buffer) {
    this.key = createHash("sha256").update(secret).digest();
  }

  seal(payload: object): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  /** Returns undefined for anything tampered with, truncated or sealed with another key. */
  unseal<T>(token: string): T | undefined {
    try {
      const raw = Buffer.from(token, "base64url");
      if (raw.length < 29) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }
}

/** SIMPRO_SECRET if set, otherwise a random key saved in the state dir (so restarts don't log everyone out). */
export function loadOrCreateSecret(stateDir: string, fromEnv?: string): string {
  if (fromEnv) return fromEnv;
  const path = join(stateDir, ".secret-key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(stateDir, { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, key, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  console.error(`[simpro-mcp] generated a new secret key at ${path}`);
  return key;
}
