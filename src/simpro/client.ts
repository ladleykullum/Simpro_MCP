/**
 * Thin HTTP client for the Simpro REST API (v1.0).
 *
 * Handles: URL building under /api/v1.0/companies/{id}/, Simpro's trailing-slash
 * routing rules, a shared rate limiter, 429 back-off, one retry after a 401
 * (token refresh), and the Result-Total / Result-Pages paging headers.
 */
import { RateLimiter, sharedLimiter } from "./rateLimiter.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | undefined | null | Array<string | number>;
export type Query = Record<string, QueryValue>;

/** Supplies the value for the Authorization: Bearer header. */
export interface TokenProvider {
  getToken(): Promise<string>;
  /** Called after a 401 so the next getToken() fetches a fresh token. */
  invalidate?(): void;
}

export class SimproError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SimproError";
  }
}

export interface Page<T = Record<string, unknown>> {
  rows: T[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
}

export interface WriteResult {
  status: number;
  /** Response body; Simpro often answers writes with 204 and no body. */
  data?: unknown;
  /** ID of a created record, from the Resource-ID or Location header. */
  resourceId?: string;
}

export interface ClientOptions {
  baseUrl: string;
  companyId: number;
  tokens: TokenProvider;
  limiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  /** Max retries on HTTP 429. */
  maxRetries?: number;
  /** Base back-off in ms (doubles each retry). */
  backoffMs?: number;
}

/** Routes that live outside /companies/{id}/. */
const UNSCOPED = /^(currentUser|info)(\/|$)|^companies\/?$/;

/**
 * Simpro's router is strict about trailing slashes: a collection ends in "/",
 * a single record (numeric or string id at the end) does not. Getting it
 * wrong yields a confusing "404 Invalid route".
 */
export function normalizePath(path: string): string {
  let p = path.trim();
  p = p.replace(/^https?:\/\/[^/]+/, ""); // tolerate full URLs / _href values
  p = p.replace(/^\/?api\/v1\.0\/companies\/\d+\//, "");
  p = p.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const [route, qs] = p.split("?", 2);
  let r = route.replace(/\/+$/, "");
  const last = r.split("/").pop() ?? "";
  const isItem = /^\d+$/.test(last) || /^[0-9a-f-]{8,}$/i.test(last);
  if (!isItem && r) r += "/";
  return qs ? `${r}?${qs}` : r;
}

export function buildQueryString(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  // Keep filter operators readable: in(1,2), between(a,b). "%" wildcards stay
  // encoded as %25 so "%ab%" can't be misread as an escape sequence.
  const qs = params.toString().replace(/%2C/gi, ",").replace(/%28/gi, "(").replace(/%29/gi, ")");
  return qs ? `?${qs}` : "";
}

function extractResourceId(headers: Headers): string | undefined {
  const direct = headers.get("Resource-ID");
  if (direct) return direct;
  const loc = headers.get("Location");
  const m = loc?.match(/\/([^/?]+)\/?(?:\?.*)?$/);
  return m?.[1];
}

/** Turns Simpro's error bodies into one readable line. */
export function describeSimproError(status: number, body: unknown): string {
  const parts: string[] = [];
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") parts.push(b.message);
    if (Array.isArray(b.errors)) {
      for (const e of b.errors as Array<Record<string, unknown>>) {
        const where = e.path ? `${e.path}: ` : "";
        const val = e.value !== undefined && e.value !== null ? ` (got ${JSON.stringify(e.value)})` : "";
        parts.push(`${where}${e.message ?? JSON.stringify(e)}${val}`);
      }
    }
  } else if (typeof body === "string" && body.trim()) {
    parts.push(body.trim().slice(0, 500));
  }
  const hint =
    status === 401
      ? "Not signed in or the token expired."
      : status === 403
        ? "The Simpro user/key does not have permission for this."
        : status === 404
          ? "Not found. Check the ID and path (collections end with '/', single records don't)."
          : status === 422 && JSON.stringify(body ?? "").toLowerCase().includes("locked")
            ? "The record is open in Simpro by someone. Ask them to close it, then retry."
            : "";
  return [`Simpro returned HTTP ${status}.`, ...parts, hint].filter(Boolean).join(" ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SimproClient {
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter ?? sharedLimiter();
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  url(path: string, query?: Query): string {
    const route = normalizePath(path);
    const routeOnly = route.split("?")[0];
    const prefix = UNSCOPED.test(routeOnly)
      ? `${this.opts.baseUrl}/api/v1.0/`
      : `${this.opts.baseUrl}/api/v1.0/companies/${this.opts.companyId}/`;
    const extra = buildQueryString(query);
    const joiner = route.includes("?") && extra ? "&" + extra.slice(1) : extra;
    return prefix + route + joiner;
  }

  private async request(
    method: HttpMethod,
    path: string,
    { query, body }: { query?: Query; body?: unknown } = {},
  ): Promise<{ status: number; data: unknown; headers: Headers }> {
    const url = this.url(path, query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      await this.limiter.take();
      const token = await this.opts.tokens.getToken();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : this.backoffMs * 2 ** attempt + Math.random() * this.backoffMs;
        await sleep(Math.min(wait, 15_000));
        continue;
      }
      if (res.status === 401 && !refreshed && this.opts.tokens.invalidate) {
        refreshed = true;
        this.opts.tokens.invalidate();
        continue;
      }

      const text = await res.text();
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) throw new SimproError(describeSimproError(res.status, data), res.status, data);
      return { status: res.status, data, headers: res.headers };
    }
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return (await this.request("GET", path, { query })).data as T;
  }

  /** One page of a collection, with Simpro's paging headers. */
  async list<T = Record<string, unknown>>(path: string, query: Query = {}): Promise<Page<T>> {
    const page = Number(query.page ?? 1) || 1;
    const pageSize = Number(query.pageSize ?? 30) || 30;
    const { data, headers } = await this.request("GET", path, { query: { ...query, page, pageSize } });
    const rows = Array.isArray(data) ? (data as T[]) : [];
    const totalRows = Number(headers.get("Result-Total")) || rows.length;
    const totalPages = Number(headers.get("Result-Pages")) || Math.max(1, Math.ceil(totalRows / pageSize));
    return { rows, page, pageSize, totalRows, totalPages };
  }

  /** Every row of a collection, up to maxRows. Uses 250-row pages. */
  async listAll<T = Record<string, unknown>>(path: string, query: Query = {}, maxRows = 2000): Promise<{ rows: T[]; truncated: boolean; totalRows: number }> {
    const rows: T[] = [];
    let page = 1;
    let totalRows = 0;
    for (;;) {
      const p = await this.list<T>(path, { ...query, page, pageSize: 250 });
      totalRows = p.totalRows;
      rows.push(...p.rows);
      if (rows.length >= maxRows) return { rows: rows.slice(0, maxRows), truncated: totalRows > maxRows, totalRows };
      if (page >= p.totalPages || p.rows.length === 0) return { rows, truncated: false, totalRows };
      page++;
    }
  }

  async write(method: Exclude<HttpMethod, "GET">, path: string, body?: unknown, query?: Query): Promise<WriteResult> {
    const { status, data, headers } = await this.request(method, path, { body, query });
    return { status, data, resourceId: extractResourceId(headers) };
  }
}
