# Hosting the Simpro MCP server for claude.ai

In hosted mode the server runs on a machine with HTTPS and is added to claude.ai as a **custom connector**. The connector then works in claude.ai on the web, desktop and mobile apps. Each person who connects signs in with their **own** Simpro login.

```
claude.ai ──OAuth (PKCE)──▶ simpro-mcp ──redirect──▶ Simpro login page
                                 ◀── Simpro sends the person back with a code
claude.ai ◀── tokens ─────────── simpro-mcp (the person's Simpro tokens are encrypted inside)
claude.ai ──POST /mcp + token──▶ simpro-mcp ──their Simpro token──▶ Simpro API
```

The server keeps no database of tokens. What it keeps in its state folder (`/data` in Docker) is:

- `.secret-key`: encrypts tokens and signs confirmations, unless `SIMPRO_SECRET` is set.
- `oauth-clients.json`: the connector registrations.
- `audit.log`: every change made in Simpro.

Keep `/data` on a persistent volume. If the secret changes, everyone has to reconnect.

## 1. Simpro OAuth app

In Simpro, go to **Setup → Integrations → API** and create an **Authorization Code** app. Set its Redirect URI to:

```
https://<your-domain>/oauth/simpro/callback
```

## 2. Settings

Create a `.env` file on the server. Never commit it.

```
SIMPRO_TRANSPORT=http
SIMPRO_BASE_URL=https://yourbuild.simprosuite.com
SIMPRO_COMPANY_ID=0
SIMPRO_CLIENT_ID=...
SIMPRO_CLIENT_SECRET=...
PUBLIC_URL=https://<your-domain>
SIMPRO_SECRET=<output of: openssl rand -hex 32>
SIMPRO_WRITE_MODE=confirm
SIMPRO_ALLOW_DELETE=false
```

## 3. Run it

### Option A: a small VPS with Docker and Caddy

Clone the repo and add `.env`, then start it:

```bash
docker compose up -d --build
```

The container listens on `127.0.0.1:3000`. Put Caddy (automatic HTTPS) in front. In `/etc/caddy/Caddyfile`:

```
simpro-mcp.yourdomain.co.nz {
    reverse_proxy 127.0.0.1:3000
}
```

### Option B: a container host (Fly.io, Railway, Render and similar)

Deploy the `Dockerfile` and set the variables above as secrets. Then:

- Attach a persistent volume at `/data`.
- Run exactly **one** instance. Sign-ins in progress and the Simpro rate limit are tracked in memory, so do not scale it out.
- Use the host's HTTPS URL as `PUBLIC_URL`.

### Check it

```bash
curl https://<your-domain>/healthz
```

That should print `ok`. Then check the sign-in metadata, which should return JSON:

```bash
curl https://<your-domain>/.well-known/oauth-authorization-server
```

## 4. Add it to claude.ai

1. In claude.ai, open **Settings → Connectors** and choose **Add custom connector**. On Team or Enterprise plans, an owner adds it for the organisation in the admin settings.
2. Enter the URL `https://<your-domain>/mcp`. Leave the advanced OAuth fields empty, because the server registers Claude automatically.
3. Click **Connect**. A Simpro login page opens. Sign in, and you are sent back to Claude.

Each team member connects once with their own Simpro login.

## Notes

- **TLS** must be handled by the proxy or host. The server itself speaks plain HTTP on `PORT`.
- **Rate limit:** Simpro allows about 10 requests per second per integration, shared by everyone. The server keeps all users under 8 per second (`SIMPRO_RATE_LIMIT`).
- **Logs** go to stderr, one line per request plus one line per write.
- **Sign-in length:** Claude refreshes tokens automatically. People reconnect after 30 days, or sooner if Simpro revokes the login.
