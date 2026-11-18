import type { Config } from "../config.js";
import { ClientCredentialsProvider, FileTokenStore, RefreshTokenProvider, StaticToken } from "./auth.js";
import { browserLogin } from "./browserLogin.js";
import type { TokenProvider } from "./client.js";

/** The token provider for local use (Claude Desktop and `npm run check`). */
export function localTokenProvider(cfg: Config): TokenProvider {
  if (cfg.authMode === "api_key") return new StaticToken(cfg.apiKey!);
  const app = { tokenUrl: cfg.tokenUrl, clientId: cfg.clientId!, clientSecret: cfg.clientSecret! };
  if (cfg.authMode === "client_credentials") return new ClientCredentialsProvider(app);
  return new RefreshTokenProvider(app, new FileTokenStore(cfg.tokenCachePath), () =>
    browserLogin({ ...app, authorizeUrl: cfg.authorizeUrl, port: cfg.redirectPort }),
  );
}
