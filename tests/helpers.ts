import { createApp } from "../src/app.js";
import { newKeyId } from "../src/core/ids.js";
import { generateApiKey, hashApiKey, keyPrefix } from "../src/core/keys.js";
import { silentLogger, type AppConfig, type Deps } from "../src/deps.js";
import { createMemoryRepos } from "../src/repos/memory.js";
import type { ApiKey } from "../src/repos/types.js";
import { FakeIdentityProvider } from "../src/services/identity.js";
import { FakeInferenceClient } from "../src/services/inference.js";
import { KeyAuthService } from "../src/services/keyAuth.js";
import { QuotaService } from "../src/services/quota.js";

export const TEST_CONFIG: AppConfig = {
  publicUrl: "http://localhost:3000",
  keyPepper: "test-pepper",
  ipHmacSecret: "ip-secret",
  sessionSecret: "session-secret-session-secret-session-secret",
  modelRevision: "test-rev",
  inferenceTimeoutMs: 1000,
  maxInputTokens: 500,
  secureCookies: false,
  magicLinkPerEmailPerHour: 5,
};

export function makeTestDeps(overrides: Partial<AppConfig> = {}) {
  const repos = createMemoryRepos();
  const config = { ...TEST_CONFIG, ...overrides };
  let now = new Date("2026-09-04T12:00:00Z");
  const clock = () => now;
  const setNow = (d: Date) => (now = d);
  const inference = new FakeInferenceClient();
  const identity = new FakeIdentityProvider();
  const deps: Deps = {
    config,
    repos,
    inference,
    identity,
    keyAuth: new KeyAuthService(repos.apiKeys, config.keyPepper, 60_000, () => now.getTime()),
    quota: new QuotaService(repos.quotaUsage, repos.quotaPlans, repos.settings, clock),
    logger: silentLogger,
    clock,
  };
  const app = createApp(deps);
  return { app, deps, repos, inference, identity, setNow, clock };
}

export async function seedKey(deps: Deps, overrides: Partial<ApiKey> = {}) {
  const secret = generateApiKey();
  const key: ApiKey = {
    id: newKeyId(),
    prefix: keyPrefix(secret),
    secret_hash: hashApiKey(secret, deps.config.keyPepper),
    name: "test key",
    owner_email: null,
    notes: null,
    created_at: deps.clock().toISOString(),
    created_by: "test",
    last_used_at: null,
    revoked_at: null,
    plan_id: "default",
    monthly_override: null,
    rps_override: null,
    ...overrides,
  };
  await deps.repos.apiKeys.create(key);
  return { secret, key };
}

export function post(app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
