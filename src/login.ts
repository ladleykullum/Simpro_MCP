#!/usr/bin/env node
/** `npm run login`: sign in to Simpro in the browser once and save the login for local use. */
import { resolve } from "node:path";
import { loadConfig, loadDotEnv } from "./config.js";
import { FileTokenStore } from "./simpro/auth.js";
import { browserLogin } from "./simpro/browserLogin.js";

loadDotEnv(process.env.SIMPRO_ENV_FILE ?? resolve(".env"));
const cfg = loadConfig({ ...process.env, SIMPRO_TRANSPORT: "stdio", SIMPRO_AUTH_MODE: "authorization_code" });

browserLogin({
  tokenUrl: cfg.tokenUrl,
  clientId: cfg.clientId!,
  clientSecret: cfg.clientSecret!,
  authorizeUrl: cfg.authorizeUrl,
  port: cfg.redirectPort,
})
  .then((t) => {
    if (!t.refresh_token) throw new Error("Simpro did not return a refresh token, so the login can't be saved.");
    new FileTokenStore(cfg.tokenCachePath).save(t.refresh_token);
    console.error(`Signed in. Login saved to ${cfg.tokenCachePath}`);
  })
  .catch((err) => {
    console.error(`Login failed: ${(err as Error).message}`);
    process.exit(1);
  });
