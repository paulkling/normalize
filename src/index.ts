import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "./app.js";
import { loadEnv, toAppConfig } from "./config.js";
import { createSql } from "./db/client.js";
import { consoleLogger, type Deps } from "./deps.js";
import { createPostgresRepos } from "./repos/postgres.js";
import { FakeIdentityProvider } from "./services/identity.js";
import { HttpLlamaClient } from "./services/inference.js";
import { KeyAuthService } from "./services/keyAuth.js";
import { QuotaService } from "./services/quota.js";
import { SupabaseIdentityProvider } from "./services/supabaseIdentity.js";

const env = loadEnv();
const config = toAppConfig(env);
const sql = createSql(env.DATABASE_URL);
const repos = createPostgresRepos(sql);
const clock = () => new Date();

const identity =
  env.IDENTITY_PROVIDER === "fake"
    ? new FakeIdentityProvider()
    : new SupabaseIdentityProvider({ url: env.SUPABASE_URL!, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!, jwtSecret: env.SUPABASE_JWT_SECRET ?? null });

if (identity instanceof FakeIdentityProvider) {
  // Local development: print the callback link instead of sending mail.
  const orig = identity.sendMagicLink.bind(identity);
  identity.sendMagicLink = async (email, redirectTo) => {
    await orig(email, redirectTo);
    const link = identity.sentLinks.at(-1)!;
    consoleLogger.info("DEV magic link", { url: `${redirectTo}?token_hash=${link.tokenHash}&type=magiclink` });
  };
}

const deps: Deps = {
  config,
  repos,
  inference: new HttpLlamaClient(env.LLAMA_URL),
  identity,
  keyAuth: new KeyAuthService(repos.apiKeys, config.keyPepper),
  quota: new QuotaService(repos.quotaUsage, repos.quotaPlans, repos.settings, clock),
  logger: consoleLogger,
  clock,
};

const app = createApp(deps, { getRemoteAddr: (c) => getConnInfo(c).remote.address ?? null });

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  consoleLogger.info("normalize listening", { host: info.address, port: info.port, llama: env.LLAMA_URL, identity: env.IDENTITY_PROVIDER, model_revision: env.MODEL_REVISION });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    consoleLogger.info("shutting down", { signal });
    server.close(() => {
      sql.end({ timeout: 5 }).finally(() => process.exit(0));
    });
  });
}
