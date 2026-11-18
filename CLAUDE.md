# CLAUDE.md

MCP server for one business's Simpro account. TypeScript, Node 20+, official MCP SDK.

## Commands

- `npm run build`: compile `src/` to `dist/`.
- `npm test`: compile with `tsconfig.test.json`, then run `node --test`. Everything runs against the simulated Simpro in `src/mock/`. No network is needed.
- `npm run mock`: run the simulated Simpro on :4010 (API key `mock-key`; OAuth client `mock-client` / `mock-secret`).
- `npm run login`: local browser sign-in that saves a refresh token.

## Layout

- `src/index.ts` picks the transport: `stdio` (Claude Desktop) or `http` (hosted claude.ai connector).
- `src/server.ts` contains `buildServer()` and registers every tool. Both transports use it.
- `src/simpro/client.ts` holds URL building, trailing-slash normalisation, the shared rate limiter, 429 back-off, a retry after a 401, and the paging headers.
- `src/simpro/auth.ts` and `browserLogin.ts` hold the token providers (API key, client credentials, refresh token) and the local OAuth login.
- `src/http/` is hosted mode. It is an OAuth 2.1 server built on the SDK's `mcpAuthRouter`. `oauthProvider.ts` handles the hop to Simpro's login, and tokens are AES-GCM sealed envelopes (`seal.ts`) carrying the user's Simpro tokens. Requests are stateless, and each one builds a fresh server and client.
- `src/safety.ts` is `WriteGuard`. **Every write must go through `guardedWrite()` in `tools/context.ts`.** It gives read_only, confirm (an HMAC token bound to method + path + body + user, 10 minute expiry) and auto modes. DELETE needs `SIMPRO_ALLOW_DELETE`. Writes are audit-logged.
- `src/tools/*.ts` has one file per area. Return results with `ok()`, and wrap handlers in `safe()`.

## Rules

- Never write to stdout. In stdio mode it carries the protocol, so use `console.error`.
- Any new write tool must use `guardedWrite`. Never call `client.write` directly from a tool.
- If a new tool hits a new endpoint, add it to the mock and add a test in `test/tools.test.ts`.

## Simpro API quirks

- Paths are under `/api/v1.0/companies/{id}/`. Collections end with `/` and records don't. Getting this wrong gives a 404 "Invalid route", and `normalizePath()` fixes it.
- There is no free-text search. Match with wildcard column filters (`Name=%smith%`). The `search` parameter only takes `all` or `any`.
- Filter operators are `gt() ge() lt() le() ne() in(a,b) between(a,b)`. Nested columns use dots (`Customer.ID`).
- The paging headers are `Result-Total` and `Result-Pages`. The maximum `pageSize` is 250.
- Customers are split between `customers/companies/` and `customers/individuals/`. Sites live at the top level `sites/`, filtered by `Customers.ID`.
- Filter schedules by `JobID`, not `Reference`. Filter invoices by job with `Jobs.ID`.
- Writes often return 204 with no body. The new ID is in the `Resource-ID` or `Location` header.
- A record someone has open in the Simpro UI is locked, and writes return 422 "currently locked by …". Never force the lock.
- Job and quote `Description` is HTML. Cost-centre notes are plain text.
- Job stages: Pending, Progress, Complete, Invoiced, Archived. Quote stages: InProgress, Complete, Approved, Archived.
- Rate limit is about 10 requests per second per integration. Simpro sends no Retry-After header, so the client backs off with jitter.

None of this has been verified on a live build from this repo yet. See the checklist in README.md.
