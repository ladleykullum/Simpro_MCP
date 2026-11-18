/**
 * Local sign-in: opens Simpro's login page in the browser and catches the
 * redirect on http://localhost:<port>/callback. The same URL must be set as
 * the Redirect URI on the Simpro OAuth app.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { requestSimproToken, type OAuthApp, type SimproTokenResponse } from "./auth.js";

export interface BrowserLoginOptions extends OAuthApp {
  authorizeUrl: string;
  port: number;
  timeoutMs?: number;
  /** Override for tests; defaults to opening the system browser. */
  openUrl?: (url: string) => void;
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center">` +
  `<h1>${title}</h1><p>${msg}</p></body>`;

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    /* the URL is also printed to stderr */
  }
}

export function browserLogin(opts: BrowserLoginOptions): Promise<SimproTokenResponse> {
  const redirectUri = `http://localhost:${opts.port}/callback`;
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL(opts.authorizeUrl);
  authUrl.searchParams.set("client_id", opts.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const q = url.searchParams;
      if (q.get("error")) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("Sign-in failed", q.get("error_description") ?? q.get("error")!));
        finish(() => reject(new Error(`Simpro sign-in failed: ${q.get("error")}`)));
        return;
      }
      // Simpro may return state empty; only reject a value that doesn't match.
      const returned = q.get("state");
      if (returned && returned !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("Sign-in failed", "State mismatch."));
        finish(() => reject(new Error("Sign-in state mismatch; aborted.")));
        return;
      }
      const code = q.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("Sign-in failed", "No code returned."));
        return;
      }
      try {
        const tokens = await requestSimproToken(opts, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        });
        res.writeHead(200, { "Content-Type": "text/html" }).end(page("✓ Signed in to Simpro", "You can close this tab and go back to Claude."));
        finish(() => resolve(tokens));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" }).end(page("Sign-in failed", String((err as Error).message)));
        finish(() => reject(err));
      }
    });

    const timer = setTimeout(
      () => finish(() => reject(new Error("Timed out waiting for Simpro sign-in."))),
      opts.timeoutMs ?? 5 * 60_000,
    );

    server.on("error", (err) => finish(() => reject(new Error(`Could not listen on ${redirectUri}: ${err.message}`))));
    server.listen(opts.port, "127.0.0.1", () => {
      const u = authUrl.toString();
      console.error(`[simpro-mcp] Sign in to Simpro in your browser. If it didn't open, visit:\n  ${u}`);
      (opts.openUrl ?? openInBrowser)(u);
    });
  });
}
