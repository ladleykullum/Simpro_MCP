/**
 * Hosted mode: an HTTPS-facing (behind a reverse proxy) MCP server that
 * claude.ai can add as a custom connector. Each person signs in with their
 * own Simpro login; requests are stateless.
 */
import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.js";
import { WriteGuard } from "../safety.js";
import { StaticToken } from "../simpro/auth.js";
import { SimproClient } from "../simpro/client.js";
import { sharedLimiter } from "../simpro/rateLimiter.js";
import { buildServer } from "../server.js";
import { FileClientsStore, SimproBrokerProvider } from "./oauthProvider.js";
import { loadOrCreateSecret, Sealer } from "./seal.js";

export const MCP_PATH = "/mcp";
export const CALLBACK_PATH = "/oauth/simpro/callback";

export function createHttpApp(cfg: Config, opts: { fetchImpl?: typeof fetch } = {}) {
  const publicUrl = new URL(cfg.publicUrl!);
  const secret = loadOrCreateSecret(cfg.stateDir, cfg.secret);
  const provider = new SimproBrokerProvider({
    app: { tokenUrl: cfg.tokenUrl, clientId: cfg.clientId!, clientSecret: cfg.clientSecret! },
    authorizeUrl: cfg.authorizeUrl,
    callbackUrl: new URL(CALLBACK_PATH, publicUrl).toString(),
    sealer: new Sealer(`${secret}:tokens`),
    clientsStore: new FileClientsStore(join(cfg.stateDir, "oauth-clients.json")),
    fetchImpl: opts.fetchImpl,
  });
  const guard = new WriteGuard(cfg.writeMode, cfg.allowDelete, `${secret}:confirm`, join(cfg.stateDir, "audit.log"));
  const limiter = sharedLimiter(cfg.requestsPerSecond);
  const resourceUrl = new URL(MCP_PATH, publicUrl);

  const app = express();
  app.set("trust proxy", 1); // TLS is terminated by the reverse proxy in front of us
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () =>
      console.error(`[simpro-mcp] ${req.ip} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`),
    );
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.type("text").send("ok");
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: resourceUrl,
      resourceName: "Simpro",
    }),
  );
  app.get(CALLBACK_PATH, (req, res) => void provider.handleSimproCallback(req, res));

  const auth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  app.post(MCP_PATH, express.json({ limit: "4mb" }), auth, async (req: Request & { auth?: AuthInfo }, res: Response) => {
    const simproToken = req.auth?.extra?.simproToken as string | undefined;
    if (!simproToken) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    const client = new SimproClient({
      baseUrl: cfg.baseUrl,
      companyId: cfg.companyId,
      tokens: new StaticToken(simproToken),
      limiter,
      fetchImpl: opts.fetchImpl,
    });
    const server = buildServer(client, guard, cfg, req.auth?.clientId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[simpro-mcp] request failed: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  // Stateless server: no SSE stream or sessions to resume/close.
  app.all(MCP_PATH, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return { app, provider };
}
