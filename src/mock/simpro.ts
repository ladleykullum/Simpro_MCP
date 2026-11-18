/**
 * A small simulated Simpro API for tests and demos. It mimics the parts of
 * Simpro the tools use: company-scoped routes, column filters with wildcards
 * and operators, `columns`, `orderby`, paging headers, notes, and OAuth.
 * It is NOT a full Simpro implementation.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as data from "./fixtures.js";
import type { Row } from "./fixtures.js";

export interface MockOptions {
  /** Bearer tokens the mock accepts. Default: "mock-key" and any token it issued. */
  apiKey?: string;
  /** Answer the first N requests with 429, to test back-off. */
  rateLimitFirst?: number;
}

export interface MockSimpro {
  url: string;
  server: Server;
  requests: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown }>;
  close(): Promise<void>;
}

const RESERVED = new Set(["columns", "page", "pageSize", "orderby", "search", "display", "limit"]);

function getPath(obj: Row, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (Array.isArray(cur)) cur = cur.map((x) => (x as Row)?.[k]);
    else cur = (cur as Row | undefined)?.[k];
  }
  return cur;
}

function compare(a: unknown, b: string): number {
  const n = Number(b);
  if (typeof a === "number" && Number.isFinite(n)) return a - n;
  return String(a ?? "").localeCompare(b);
}

function matchOne(value: unknown, expr: string): boolean {
  if (Array.isArray(value)) return value.some((v) => matchOne(v, expr));
  const op = /^(gt|ge|lt|le|ne|in|between)\((.*)\)$/.exec(expr);
  if (op) {
    const [, name, inner] = op;
    const args = inner.split(",");
    switch (name) {
      case "gt": return compare(value, args[0]) > 0;
      case "ge": return compare(value, args[0]) >= 0;
      case "lt": return compare(value, args[0]) < 0;
      case "le": return compare(value, args[0]) <= 0;
      case "ne": return String(value) !== args[0];
      case "in": return args.includes(String(value));
      case "between": return compare(value, args[0]) >= 0 && compare(value, args[1]) <= 0;
    }
  }
  if (expr.includes("%")) {
    const re = new RegExp("^" + expr.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
    return re.test(String(value ?? ""));
  }
  if (typeof value === "boolean") return String(value) === expr.toLowerCase();
  return String(value ?? "") === expr;
}

function pick(row: Row, columns?: string): Row {
  if (!columns) return row;
  const out: Row = {};
  for (const col of columns.split(",")) {
    const top = col.split(".")[0];
    if (row[top] !== undefined) out[top] = row[top];
  }
  return out;
}

export function startMockSimpro(opts: MockOptions = {}, port = 0): Promise<MockSimpro> {
  const apiKey = opts.apiKey ?? "mock-key";
  const issued = new Set<string>([apiKey]);
  const codes = new Map<string, string>();
  let rateLimited = opts.rateLimitFirst ?? 0;
  const requests: MockSimpro["requests"] = [];
  let nextId = 9000;

  const collections: Record<string, Row[]> = {
    jobs: data.jobs,
    quotes: data.quotes,
    invoices: data.invoices,
    schedules: data.schedules,
    sites: data.sites,
    employees: data.employees,
    contractors: data.contractors,
    "customers/companies": data.companies,
    "customers/individuals": data.individuals,
  };

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const list = (res: ServerResponse, rows: Row[], q: Record<string, string>) => {
    let out = rows.filter((r) =>
      Object.entries(q).every(([k, v]) => RESERVED.has(k) || matchOne(getPath(r, k), v)),
    );
    if (q.orderby) {
      const desc = q.orderby.startsWith("-");
      const key = q.orderby.replace(/^-/, "");
      out = [...out].sort((a, b) => {
        const c = String(getPath(a, key) ?? "").localeCompare(String(getPath(b, key) ?? ""), undefined, { numeric: true });
        return desc ? -c : c;
      });
    }
    const pageSize = Math.min(Number(q.pageSize) || 30, 250);
    const page = Number(q.page) || 1;
    const total = out.length;
    const slice = out.slice((page - 1) * pageSize, page * pageSize).map((r) => pick(r, q.columns));
    send(res, 200, slice, { "Result-Total": String(total), "Result-Pages": String(Math.max(1, Math.ceil(total / pageSize))) });
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const q = Object.fromEntries(url.searchParams);
    let body: unknown;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length) {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    // ----- OAuth -----
    if (url.pathname === "/oauth2/login") {
      // Simulates the user signing in and approving straight away.
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, q.redirect_uri ?? "");
      const back = new URL(q.redirect_uri);
      back.searchParams.set("code", code);
      if (q.state) back.searchParams.set("state", q.state);
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (url.pathname === "/oauth2/token" && req.method === "POST") {
      const b = (body ?? {}) as Record<string, string>;
      if (b.client_id !== "mock-client" || b.client_secret !== "mock-secret") return send(res, 401, { error: "invalid_client" });
      if (b.grant_type === "authorization_code" && !codes.delete(b.code)) return send(res, 400, { error: "invalid_grant" });
      if (b.grant_type === "refresh_token" && !String(b.refresh_token).startsWith("mock-refresh-")) {
        return send(res, 400, { error: "invalid_grant" });
      }
      const access = `mock-access-${Math.random().toString(36).slice(2)}`;
      issued.add(access);
      return send(res, 200, {
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        ...(b.grant_type !== "client_credentials" ? { refresh_token: `mock-refresh-${Math.random().toString(36).slice(2)}` } : {}),
      });
    }

    // ----- API -----
    const m = /^\/api\/v1\.0\/companies\/0\/(.*)$/.exec(url.pathname);
    if (!m) return send(res, 404, { errors: [{ message: "Invalid route" }] });
    const path = m[1];
    requests.push({ method: req.method ?? "GET", path, query: q, body });

    if (rateLimited > 0) {
      rateLimited--;
      return send(res, 429, { message: "Too many requests" });
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!issued.has(token)) return send(res, 401, { message: "Invalid token" });

    // notes (read + create)
    const notesMatch = /^(jobs|quotes)\/(\d+)\/notes\/$/.exec(path);
    if (notesMatch) {
      const key = `${notesMatch[1]}/${notesMatch[2]}`;
      if (req.method === "POST") {
        const b = body as Row;
        if (!b?.Subject) return send(res, 422, { errors: [{ path: "/Subject", message: "Subject is required" }] });
        const id = nextId++;
        (data.notes[key] ??= []).push({ ID: id, ...b });
        return send(res, 201, { ID: id, ...b }, { "Resource-ID": String(id) });
      }
      return send(res, 200, data.notes[key] ?? []);
    }

    // sections / cost centres
    let sm = /^jobs\/(\d+)\/sections\/$/.exec(path);
    if (sm) return send(res, 200, data.jobSections[Number(sm[1])] ?? []);
    sm = /^jobs\/(\d+)\/sections\/(\d+)\/costCenters\/$/.exec(path);
    if (sm) return send(res, 200, data.jobCostCenters[`${sm[1]}/${sm[2]}`] ?? []);
    if (/^quotes\/\d+\/sections\/$/.test(path)) return send(res, 200, []);

    // contacts
    const cm = /^customers\/(companies|individuals)\/(\d+)\/contacts\/$/.exec(path);
    if (cm) return list(res, data.contacts[Number(cm[2])] ?? [], q);

    // generic collection / record
    const rm = /^(.*?)\/(\d+)$/.exec(path);
    if (rm && collections[rm[1]]) {
      const row = collections[rm[1]].find((r) => r.ID === Number(rm[2]));
      if (!row) return send(res, 404, { errors: [{ message: "Record not found" }] });
      if (req.method === "PATCH") {
        Object.assign(row, body as Row);
        return send(res, 204);
      }
      if (req.method === "DELETE") return send(res, 204);
      return send(res, 200, pick(row, q.columns));
    }
    const coll = path.replace(/\/$/, "");
    if (path.endsWith("/") && collections[coll]) {
      if (req.method === "POST") {
        const id = nextId++;
        collections[coll].push({ ID: id, ...(body as Row) });
        return send(res, 201, undefined, { "Resource-ID": String(id) });
      }
      return list(res, collections[coll], q);
    }
    if (!path.endsWith("/") && collections[path]) return send(res, 404, { errors: [{ message: "Invalid route" }] });
    return send(res, 404, { errors: [{ message: "Invalid route" }] });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => send(res, 500, { message: String(err) }));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${p}`,
        server,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
