/**
 * Ways of getting a Simpro access token.
 *
 *  - StaticToken: a legacy API key, or a bearer handed to us per request (hosted mode).
 *  - ClientCredentialsProvider: machine login, no user.
 *  - RefreshTokenProvider: a user's login; swaps a refresh token for access tokens
 *    and saves the rotated refresh token (local mode caches it in a file).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { SimproError, type TokenProvider } from "./client.js";

export interface SimproTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

export interface OAuthApp {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

/** POST to Simpro's /oauth2/token. Simpro accepts a JSON body. */
export async function requestSimproToken(
  app: OAuthApp,
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<SimproTokenResponse> {
  const res = await fetchImpl(app.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...params, client_id: app.clientId, client_secret: app.clientSecret }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SimproError(`Simpro sign-in failed (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status, text);
  }
  const json = JSON.parse(text) as SimproTokenResponse;
  if (!json.access_token) throw new SimproError("Simpro token response had no access_token", 502, json);
  return json;
}

const SKEW_MS = 60_000;
const DEFAULT_TTL_MS = 3_600_000;

function ttl(expiresIn?: number): number {
  return expiresIn && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_TTL_MS;
}

export class StaticToken implements TokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

/** Shares a single in-flight refresh between concurrent callers. */
abstract class CachingProvider implements TokenProvider {
  private token?: string;
  private expiresAt = 0;
  private inFlight?: Promise<string>;

  protected abstract fetchToken(): Promise<SimproTokenResponse>;

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - SKEW_MS) return this.token;
    this.inFlight ??= this.fetchToken()
      .then((t) => {
        this.token = t.access_token;
        this.expiresAt = Date.now() + ttl(t.expires_in);
        return t.access_token;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
  }
}

export class ClientCredentialsProvider extends CachingProvider {
  constructor(
    private readonly app: OAuthApp,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }
  protected fetchToken() {
    return requestSimproToken(this.app, { grant_type: "client_credentials" }, this.fetchImpl);
  }
}

export interface RefreshTokenStore {
  load(): string | undefined;
  save(refreshToken: string): void;
}

/** Stores the refresh token in a local file readable only by this user. */
export class FileTokenStore implements RefreshTokenStore {
  constructor(private readonly path: string) {}
  load(): string | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return (JSON.parse(readFileSync(this.path, "utf8")) as { refresh_token?: string }).refresh_token;
    } catch {
      return undefined;
    }
  }
  save(refreshToken: string): void {
    writeFileSync(this.path, JSON.stringify({ refresh_token: refreshToken, saved_at: new Date().toISOString() }), {
      mode: 0o600,
    });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort on non-POSIX filesystems */
    }
  }
}

export class RefreshTokenProvider extends CachingProvider {
  constructor(
    private readonly app: OAuthApp,
    private readonly store: RefreshTokenStore,
    /** Runs the browser login when there is no usable refresh token. Returns tokens. */
    private readonly login?: () => Promise<SimproTokenResponse>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  protected async fetchToken(): Promise<SimproTokenResponse> {
    const refresh = this.store.load();
    if (refresh) {
      try {
        const t = await requestSimproToken(this.app, { grant_type: "refresh_token", refresh_token: refresh }, this.fetchImpl);
        if (t.refresh_token) this.store.save(t.refresh_token);
        return t;
      } catch (err) {
        if (!this.login) throw err;
        console.error("[simpro-mcp] Saved Simpro login no longer works; opening the browser to sign in again.");
      }
    }
    if (!this.login) {
      throw new SimproError("Not signed in to Simpro. Run `npm run login` first.", 401);
    }
    const t = await this.login();
    if (t.refresh_token) this.store.save(t.refresh_token);
    return t;
  }
}
