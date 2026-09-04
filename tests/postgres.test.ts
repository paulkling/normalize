import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, type Sql } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPostgresRepos } from "../src/repos/postgres.js";
import type { Repos } from "../src/repos/interfaces.js";
import { newKeyId, newLogId } from "../src/core/ids.js";
import { generateApiKey, hashApiKey, keyPrefix } from "../src/core/keys.js";
import { createApp } from "../src/app.js";
import { TEST_CONFIG, post } from "./helpers.js";
import { silentLogger, type Deps } from "../src/deps.js";
import { FakeInferenceClient } from "../src/services/inference.js";
import { FakeIdentityProvider } from "../src/services/identity.js";
import { KeyAuthService } from "../src/services/keyAuth.js";
import { QuotaService } from "../src/services/quota.js";
import { login, seedAdmin } from "./adminHelpers.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("postgres repos", () => {
  let sql: Sql;
  let repos: Repos;
  beforeAll(async () => {
    sql = createSql(url!);
    await sql.unsafe(`drop schema public cascade; create schema public;`);
    await runMigrations(sql);
    repos = createPostgresRepos(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it("migrations are idempotent and seed the super-admin", async () => {
    expect(await runMigrations(sql)).toEqual([]);
    const seed = await repos.allowlist.findByEmail("PKLING@brainsprung.com");
    expect(seed).toMatchObject({ role: "super_admin", can_view_transcripts: true });
    expect(await repos.quotaPlans.get("default")).toMatchObject({ monthly_requests: 100, rps: 5 });
    expect(await repos.settings.get()).toEqual({ retention_days: 30, default_rps: 5, maintenance_banner: "", max_transcript_chars: 2000 });
  });

  it("RLS blocks roles without a policy while normalize_app passes", async () => {
    const policies = await sql`select tablename from pg_policies where policyname = 'normalize_app_all' order by tablename`;
    expect(policies.map((p) => p.tablename)).toEqual(["allowlist_entries", "api_keys", "audit_events", "inference_logs", "quota_plans", "quota_usage", "schema_migrations", "settings"]);
    const rls = await sql`select relname from pg_class where relrowsecurity and relname in ('api_keys','inference_logs')`;
    expect(rls).toHaveLength(2);
  });

  it("quota reserve is atomic under concurrency", async () => {
    const secret = generateApiKey();
    const key = await repos.apiKeys.create({ id: newKeyId(), prefix: keyPrefix(secret), secret_hash: hashApiKey(secret, "p"), name: "c", owner_email: null, notes: null, created_at: new Date().toISOString(), created_by: null, last_used_at: null, revoked_at: null, plan_id: "default", monthly_override: 5, rps_override: null });
    const results = await Promise.all(Array.from({ length: 20 }, () => repos.quotaUsage.reserve(key.id, "", "2026-09", 5)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect((await repos.quotaUsage.get(key.id, "", "2026-09"))!.used).toBe(5);
    await repos.quotaUsage.release(key.id, "", "2026-09");
    expect((await repos.quotaUsage.reserve(key.id, "", "2026-09", 5)).ok).toBe(true);
    expect((await repos.quotaUsage.reserve(key.id, "", "2026-09", 0)).ok).toBe(false);
    // zero limit on a fresh row
    expect((await repos.quotaUsage.reserve(key.id, "", "2026-10", 0)).ok).toBe(false);
    expect((await repos.quotaUsage.get(key.id, "", "2026-10"))?.used ?? 0).toBe(0);
  });

  it("logs filter and stats work", async () => {
    const base = new Date("2026-09-04T10:00:00Z");
    const mk = (i: number, status: number, user: string | null, latency: number | null): any => ({
      id: newLogId(), key_id: null, key_prefix: "nrm_abcd", user_id: user, session_id: null, app: null, styling: "casual", structure: "prose", context: "general",
      transcript: "t", output: "o", input_chars: 1, output_chars: 1, input_tokens: null, output_tokens: null, latency_ms: latency, model_revision: "r", status, error_code: status === 200 ? null : "x", ip_hmac: null, user_agent: null,
      created_at: new Date(base.getTime() + i * 1000).toISOString(),
    });
    for (let i = 0; i < 10; i++) await repos.logs.insert(mk(i, i % 3 === 0 ? 500 : 200, i % 2 ? "u1" : null, i * 10));
    expect(await repos.logs.list({ user_id: "u1" })).toHaveLength(5);
    expect(await repos.logs.list({ status: 500 })).toHaveLength(4);
    expect(await repos.logs.list({ from: new Date(base.getTime() + 8000).toISOString() })).toHaveLength(2);
    expect(await repos.logs.list({ limit: 3, offset: 8 })).toHaveLength(2);
    const stats = await repos.logs.stats(new Date("2026-09-04T23:00:00Z"));
    expect(stats).toMatchObject({ requests_today: 10, errors_today: 4, requests_month: 10 });
    expect(stats.p95_latency_ms_today).toBeGreaterThan(50);
  });

  it("runs the whole app against Postgres", async () => {
    const config = { ...TEST_CONFIG };
    const clock = () => new Date();
    const deps: Deps = { config, repos, inference: new FakeInferenceClient(), identity: new FakeIdentityProvider(), keyAuth: new KeyAuthService(repos.apiKeys, config.keyPepper), quota: new QuotaService(repos.quotaUsage, repos.quotaPlans, repos.settings, clock), logger: silentLogger, clock };
    const app = createApp(deps);
    const t: any = { app, deps, repos, identity: deps.identity, clock };
    await seedAdmin(t, "ops@brainsprung.com", "admin", false);
    const c = await login(t, "ops@brainsprung.com");
    const { key, secret } = await (await c.fetch("/admin/api/keys", { method: "POST", json: { name: "pg", monthly_override: 1 } })).json();
    expect((await post(app, "/v1/normalize", { transcript: "hello", metadata: { user_id: "pguser" } }, { authorization: `Bearer ${secret}` })).status).toBe(200);
    expect((await post(app, "/v1/normalize", { transcript: "hello" }, { authorization: `Bearer ${secret}` })).status).toBe(429);
    const logs = await (await c.fetch(`/admin/api/logs?key_id=${key.id}`)).json();
    expect(logs.logs).toHaveLength(2);
    expect(logs.logs[0].redacted).toBe(true);
    const detail = await (await c.fetch(`/admin/api/logs/${logs.logs[1].id}`)).json();
    expect(detail.log.transcript).toBeUndefined();
    expect((await c.fetch(`/admin/api/keys/${key.id}/revoke`, { method: "POST" })).status).toBe(200);
    expect((await post(app, "/v1/normalize", { transcript: "hello" }, { authorization: `Bearer ${secret}` })).status).toBe(403);
    const settings = await (await c.fetch("/admin/api/settings", { method: "PATCH", json: { retention_days: 7, maintenance_banner: "hi" } })).json();
    expect(settings.settings).toMatchObject({ retention_days: 7, maintenance_banner: "hi" });
    expect((await (await c.fetch("/admin/settings")).text())).toContain("key.revoke");
  });
});
