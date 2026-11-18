/**
 * OAuth 2.1 authorization server for the claude.ai connector, sitting in
 * front of Simpro's own OAuth login.
 *
 *   Claude ──/authorize──▶ this server ──redirect──▶ Simpro login
 *   Simpro ──/oauth/simpro/callback?code──▶ this server (swaps code for Simpro tokens)
 *   this server ──redirect with our own code──▶ Claude ──/token──▶ sealed tokens
 *
 * The tokens Claude receives are AES-GCM envelopes carrying the user's Simpro
 * tokens. PKCE, client registration (DCR) and metadata are handled by the MCP
 * SDK's router; this class supplies the storage and the Simpro hop.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { requestSimproToken, type OAuthApp, type SimproTokenResponse } from "../simpro/auth.js";
import type { Sealer } from "./seal.js";

const FLOW_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const MAX_PENDING = 5_000;
/** Our refresh tokens stop working after this long; the user then signs in again. */
const REFRESH_TTL_MS = 30 * 24 * 3_600_000;
export const FLOW_COOKIE = "simpro_mcp_flow";

interface AccessEnvelope {
  t: "a";
  sat: string; // Simpro access token
  cid: string; // our client id
  exp: number; // seconds since epoch
}
interface RefreshEnvelope {
  t: "r";
  srt: string; // Simpro refresh token
  cid: string;
  exp: number; // ms since epoch
}
interface Flow {
  clientId: string;
  params: AuthorizationParams;
  expires: number;
}
interface IssuedCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  simpro: SimproTokenResponse;
  expires: number;
}

class Expiring<V extends { expires: number }> {
  private readonly m = new Map<string, V>();
  set(k: string, v: V): void {
    if (this.m.size >= MAX_PENDING) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, v);
  }
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v && v.expires < Date.now()) {
      this.m.delete(k);
      return undefined;
    }
    return v;
  }
  take(k: string): V | undefined {
    const v = this.get(k);
    this.m.delete(k);
    return v;
  }
}

/** Dynamic client registrations, saved to a JSON file so they survive restarts. */
export class FileClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        for (const c of JSON.parse(readFileSync(path, "utf8")) as OAuthClientInformationFull[]) this.clients.set(c.client_id, c);
      } catch (err) {
        console.error(`[simpro-mcp] could not read ${path}: ${(err as Error).message}`);
      }
    }
  }

  getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.clients.values()], null, 1), { mode: 0o600 });
    return full;
  }
}

export interface SimproBrokerOptions {
  app: OAuthApp;
  authorizeUrl: string;
  /** Must exactly match the Redirect URI on the Simpro OAuth app. */
  callbackUrl: string;
  sealer: Sealer;
  clientsStore: OAuthRegisteredClientsStore;
  fetchImpl?: typeof fetch;
}

export class SimproBrokerProvider implements OAuthServerProvider {
  private readonly flows = new Expiring<Flow>();
  private readonly codes = new Expiring<IssuedCode>();

  constructor(private readonly opts: SimproBrokerOptions) {}

  get clientsStore() {
    return this.opts.clientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const flowId = randomBytes(18).toString("base64url");
    this.flows.set(flowId, { clientId: client.client_id, params, expires: Date.now() + FLOW_TTL_MS });
    const url = new URL(this.opts.authorizeUrl);
    url.searchParams.set("client_id", this.opts.app.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.opts.callbackUrl);
    url.searchParams.set("state", flowId);
    // Backup in case Simpro doesn't send state back.
    res.cookie(FLOW_COOKIE, flowId, { httpOnly: true, secure: true, sameSite: "lax", maxAge: FLOW_TTL_MS });
    res.redirect(302, url.toString());
  }

  /** Express handler for Simpro's redirect back to us. */
  async handleSimproCallback(req: Request, res: Response): Promise<void> {
    const q = req.query as Record<string, string | undefined>;
    const flowId = q.state || readCookie(req, FLOW_COOKIE);
    const flow = flowId ? this.flows.take(flowId) : undefined;
    res.clearCookie(FLOW_COOKIE);
    if (!flow) {
      res.status(400).type("html").send("<h1>Sign-in expired</h1><p>Please go back to Claude and connect again.</p>");
      return;
    }
    const back = new URL(flow.params.redirectUri);
    if (flow.params.state) back.searchParams.set("state", flow.params.state);

    if (q.error || !q.code) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", q.error_description || q.error || "Simpro returned no code");
      res.redirect(302, back.toString());
      return;
    }
    try {
      const simpro = await requestSimproToken(
        this.opts.app,
        { grant_type: "authorization_code", code: q.code, redirect_uri: this.opts.callbackUrl },
        this.opts.fetchImpl,
      );
      const code = randomBytes(24).toString("base64url");
      this.codes.set(code, {
        clientId: flow.clientId,
        codeChallenge: flow.params.codeChallenge,
        redirectUri: flow.params.redirectUri,
        simpro,
        expires: Date.now() + CODE_TTL_MS,
      });
      back.searchParams.set("code", code);
    } catch (err) {
      console.error(`[simpro-mcp] Simpro code exchange failed: ${(err as Error).message}`);
      back.searchParams.set("error", "server_error");
      back.searchParams.set("error_description", "Could not complete Simpro sign-in");
    }
    res.redirect(302, back.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const c = this.codes.take(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    return this.issue(client.client_id, c.simpro);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const env = this.opts.sealer.unseal<RefreshEnvelope>(refreshToken);
    if (!env || env.t !== "r" || env.cid !== client.client_id || env.exp < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    let simpro: SimproTokenResponse;
    try {
      simpro = await requestSimproToken(
        this.opts.app,
        { grant_type: "refresh_token", refresh_token: env.srt },
        this.opts.fetchImpl,
      );
    } catch {
      throw new InvalidGrantError("Simpro no longer accepts this login; please reconnect");
    }
    // Simpro may or may not rotate refresh tokens; keep the old one if not.
    return this.issue(client.client_id, { ...simpro, refresh_token: simpro.refresh_token ?? env.srt });
  }

  private issue(clientId: string, simpro: SimproTokenResponse): OAuthTokens {
    const expiresIn = simpro.expires_in && simpro.expires_in > 0 ? simpro.expires_in : 3600;
    const access: AccessEnvelope = {
      t: "a",
      sat: simpro.access_token,
      cid: clientId,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
    };
    const tokens: OAuthTokens = {
      access_token: this.opts.sealer.seal(access),
      token_type: "Bearer",
      expires_in: expiresIn,
    };
    if (simpro.refresh_token) {
      const refresh: RefreshEnvelope = { t: "r", srt: simpro.refresh_token, cid: clientId, exp: Date.now() + REFRESH_TTL_MS };
      tokens.refresh_token = this.opts.sealer.seal(refresh);
    }
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const env = this.opts.sealer.unseal<AccessEnvelope>(token);
    if (!env || env.t !== "a") throw new InvalidTokenError("Invalid access token");
    if (env.exp < Date.now() / 1000) throw new InvalidTokenError("Access token expired");
    return { token, clientId: env.cid, scopes: [], expiresAt: env.exp, extra: { simproToken: env.sat } };
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
