# Simpro MCP server

Lets Claude work with a Simpro account. You ask in plain English and Claude looks things up, and with your approval makes changes, in Simpro.

> Unofficial: not made, endorsed or supported by Simpro.

**Examples of what you can ask**

- "What's Mere booked on this week?"
- "Show me all jobs in progress for Harbourview."
- "Who owes us money, and what's more than 30 days overdue?"
- "How much have we quoted this month, and how much was won?"
- "How's job 1001 tracking against budget? How much is left to invoice?"
- "Give me everything on Greenfield Dairy: contacts, sites, open jobs, unpaid invoices."
- "Add a note to job 1003 that the heat pump arrives Tuesday." (previewed first, then runs once you say yes)

## Tools

| Area | Tools |
|---|---|
| Jobs & scheduling | `find_jobs`, `get_job` (with cost centres, notes, bookings, invoices), `job_financials`, `find_schedule`, `list_staff`, `add_note` |
| Quotes & sales | `find_quotes`, `get_quote`, `quote_pipeline` |
| Invoicing & money | `find_invoices` (unpaid / overdue), `get_invoice`, `aged_receivables` |
| Customers & sites | `find_customers`, `customer_overview`, `find_sites`, `get_site` |
| Everything else | `simpro_api_guide`, `simpro_get` (read any endpoint), `simpro_write` (create, update or delete anything) |

## Safety

This server can change real Simpro data, so writes are guarded:

| Setting | What it does |
|---|---|
| `SIMPRO_WRITE_MODE=confirm` **(default)** | Every change first returns a preview. It only runs when Claude calls again with a one-time token, after you have said yes. The token only works for that exact change, for 10 minutes. |
| `SIMPRO_WRITE_MODE=read_only` | No changes at all. |
| `SIMPRO_WRITE_MODE=auto` | Changes run straight away. Not recommended. |
| `SIMPRO_ALLOW_DELETE=false` **(default)** | Deleting is refused in every mode. |

Every change made is written to an audit log (`data/audit.log`, or `/data/audit.log` in Docker).

Claude acts with the permissions of the Simpro login or key it uses. For extra safety, sign in as a Simpro user that only has the permissions it needs.

## 1. What you need from Simpro

Create an OAuth app in Simpro under **Setup → Integrations → API**. Choose the **Authorization Code** type and note:

- **Build URL**: the address you log in to, for example `https://yourbuild.simprosuite.com`.
- **Company ID**: usually `0`.
- **Client ID** and **Client secret**.
- **Redirect URI**: set it to
  - `http://localhost:8237/callback` for local use, or
  - `https://<your-server>/oauth/simpro/callback` for hosted use.

A legacy Simpro **API key** also works for local use.

## 2. Local use with Claude Desktop

**Not a developer?** Follow the step-by-step guide for Windows and Mac: **[docs/INSTALL.md](docs/INSTALL.md)**.

You need Node.js 20 or newer. The server reads `.env` and saves its login inside the project folder, wherever it is started from.

```bash
git clone https://github.com/ladleykullum/Simpro_MCP.git
```

```bash
cd Simpro_MCP && npm ci && npm run build
```

```bash
cp .env.example .env
```

Fill in `.env` with your build URL and either the Client ID and secret or an API key. If you use OAuth, sign in once. A browser tab opens, and the login is saved to `.simpro-tokens.json`:

```bash
npm run login
```

Then add the server to Claude Desktop (**Settings → Developer → Edit Config**) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "simpro": {
      "command": "node",
      "args": ["/full/path/to/Simpro_MCP/dist/index.js"]
    }
  }
}
```

Keep `.env` and `.simpro-tokens.json` private. Anyone with them can act in Simpro as you.

## 3. Hosted use (claude.ai on web and mobile, whole team)

Run the server on a machine with HTTPS, then add it in claude.ai as a custom connector. Each person signs in with their own Simpro login, so their Simpro permissions apply. See **[docs/deploy.md](docs/deploy.md)**.

## Try it without a Simpro account

A simulated Simpro with made-up data is included:

```bash
npm run build && npm run mock
```

Then point a second copy at it: set `SIMPRO_BASE_URL=http://127.0.0.1:4010` and `SIMPRO_API_KEY=mock-key`.

## Project status

The server is fully tested against the **simulated** Simpro (`npm test`). It has **not yet been run against a real Simpro build.** Field names and filters follow Simpro's API, but check these on the first real run:

- [ ] Signing in (local `npm run login` and the hosted connector)
- [ ] `find_jobs`, `find_quotes`, `find_invoices` filters (stage, dates, `IsPaid`, `DueDate`)
- [ ] `job_financials`: which cost and margin fields the build returns in `Totals`
- [ ] `aged_receivables`: whether invoices report a remaining balance (part-payments)
- [ ] `find_schedule` date and staff filters
- [ ] `add_note` on a test job

## Development

```bash
npm run build
```

```bash
npm test
```

The code lives in `src/`: `simpro/` holds the API client and sign-in, `tools/` holds one file per area, `http/` holds hosted mode, and `mock/` holds the simulated Simpro. See `CLAUDE.md` for Simpro API quirks.
