import { Hono } from "hono";
import { z } from "zod";
import { ApiError, errorBody } from "../../core/errors.js";
import { newKeyId } from "../../core/ids.js";
import { generateApiKey, hashApiKey, keyPrefix } from "../../core/keys.js";
import { currentPeriod, periodResetAt } from "../../core/period.js";
import type { Deps } from "../../deps.js";
import type { LogFilter } from "../../repos/interfaces.js";
import { DEFAULT_PLAN_ID, type ApiKey, type ApiKeyPublic, type InferenceLog, type InferenceLogView } from "../../repos/types.js";
import { requireAdmin, requireSuperAdmin, type AdminEnv } from "./middleware.js";

export function publicKey(k: ApiKey): ApiKeyPublic {
  const { secret_hash: _hash, ...rest } = k;
  return rest;
}

export function viewLog(row: InferenceLog, canView: boolean): InferenceLogView {
  const { transcript, output, ...rest } = row;
  return canView ? { ...rest, transcript, output, redacted: false } : { ...rest, redacted: true };
}

const optionalInt = (max: number) => z.int().min(0).max(max).nullable().optional();

const createKeySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  owner_email: z.email().max(254).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  monthly_override: optionalInt(10_000_000),
  rps_override: z.int().min(1).max(1000).nullable().optional(),
});

const patchKeySchema = createKeySchema.partial();

const allowlistCreateSchema = z.strictObject({
  email: z.email().max(254),
  role: z.enum(["super_admin", "admin"]).default("admin"),
  can_view_transcripts: z.boolean().optional(),
});

const allowlistPatchSchema = z.strictObject({
  role: z.enum(["super_admin", "admin"]).optional(),
  can_view_transcripts: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

const quotaPatchSchema = z.strictObject({
  monthly_requests: z.int().min(0).max(10_000_000).optional(),
  rps: z.int().min(1).max(1000).optional(),
});

const settingsPatchSchema = z.strictObject({
  retention_days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
  default_rps: z.int().min(1).max(1000).optional(),
  maintenance_banner: z.string().max(500).optional(),
  max_transcript_chars: z.int().min(1).max(20_000).optional(),
});

const logQuerySchema = z.object({
  key_id: z.string().max(64).optional(),
  user_id: z.string().max(128).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  status: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function invalid(details: unknown): never {
  throw new ApiError("invalid_request", "Request body failed validation.", { details });
}

async function parseJson<T>(c: any, schema: z.ZodType<T>): Promise<T> {
  const body = await c.req.json().catch(() => invalid("Body must be valid JSON."));
  const r = schema.safeParse(body);
  if (!r.success) invalid(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export function adminApiRoutes(deps: Deps) {
  const app = new Hono<AdminEnv>();
  app.use("*", requireAdmin(deps));

  const audit = (c: any, action: string, target: string | null, details: Record<string, unknown> | null = null) =>
    deps.repos.audit.record({ actor_email: c.get("admin").email, action, target, details });

  app.get("/me", (c) => {
    const { entry } = c.get("admin");
    return c.json({ email: entry.email, role: entry.role, can_view_transcripts: entry.can_view_transcripts, csrf_token: c.get("csrfToken") });
  });

  // ---- Dashboard ----
  app.get("/dashboard", async (c) => {
    const now = deps.clock();
    const stats = await deps.repos.logs.stats(now);
    const keys = await deps.repos.apiKeys.list();
    const usage = await deps.repos.quotaUsage.listForPeriod(currentPeriod(now));
    const usedByKey = new Map(usage.filter((u) => u.user_id === "").map((u) => [u.key_id, u]));
    const perKey = await Promise.all(
      keys.map(async (k) => {
        const limits = await deps.quota.limitsFor(k);
        const u = usedByKey.get(k.id);
        const limit = limits.monthly + (u?.topped_up ?? 0);
        return { id: k.id, name: k.name, prefix: k.prefix, revoked: !!k.revoked_at, used: u?.used ?? 0, limit, remaining: Math.max(0, limit - (u?.used ?? 0)) };
      }),
    );
    const active = perKey.filter((k) => !k.revoked);
    const totalLimit = active.reduce((s, k) => s + k.limit, 0);
    const totalUsed = active.reduce((s, k) => s + k.used, 0);
    return c.json({
      period: currentPeriod(now),
      reset_at: periodResetAt(now),
      requests_today: stats.requests_today,
      errors_today: stats.errors_today,
      error_rate_today: stats.requests_today ? stats.errors_today / stats.requests_today : 0,
      p95_latency_ms_today: stats.p95_latency_ms_today,
      requests_month: stats.requests_month,
      quota_burn: totalLimit ? totalUsed / totalLimit : 0,
      quota_used: totalUsed,
      quota_limit: totalLimit,
      keys: perKey,
    });
  });

  // ---- Keys ----
  app.get("/keys", async (c) => {
    const keys = await deps.repos.apiKeys.list();
    const out = await Promise.all(keys.map(async (k) => ({ ...publicKey(k), usage: await deps.quota.remainingFor(k) })));
    return c.json({ keys: out });
  });

  app.post("/keys", async (c) => {
    const input = await parseJson(c, createKeySchema);
    const secret = generateApiKey();
    const key: ApiKey = {
      id: newKeyId(),
      prefix: keyPrefix(secret),
      secret_hash: hashApiKey(secret, deps.config.keyPepper),
      name: input.name,
      owner_email: input.owner_email ?? null,
      notes: input.notes ?? null,
      created_at: deps.clock().toISOString(),
      created_by: c.get("admin").email,
      last_used_at: null,
      revoked_at: null,
      plan_id: DEFAULT_PLAN_ID,
      monthly_override: input.monthly_override ?? null,
      rps_override: input.rps_override ?? null,
    };
    await deps.repos.apiKeys.create(key);
    await audit(c, "key.create", key.id, { name: key.name, prefix: key.prefix, monthly_override: key.monthly_override, rps_override: key.rps_override });
    return c.json({ key: publicKey(key), secret }, 201);
  });

  app.get("/keys/:id", async (c) => {
    const key = await deps.repos.apiKeys.findById(c.req.param("id"));
    if (!key) throw new ApiError("not_found", "Key not found.");
    const canView = c.get("admin").entry.can_view_transcripts;
    const logs = await deps.repos.logs.list({ key_id: key.id, limit: 25 });
    return c.json({ key: publicKey(key), usage: await deps.quota.remainingFor(key), limits: await deps.quota.limitsFor(key), recent_logs: logs.map((l) => viewLog(l, false)), can_view_transcripts: canView });
  });

  app.patch("/keys/:id", async (c) => {
    const input = await parseJson(c, patchKeySchema);
    const key = await deps.repos.apiKeys.update(c.req.param("id"), input);
    if (!key) throw new ApiError("not_found", "Key not found.");
    deps.keyAuth.invalidate(key.id);
    await audit(c, "key.update", key.id, input);
    return c.json({ key: publicKey(key) });
  });

  app.post("/keys/:id/revoke", async (c) => {
    const existing = await deps.repos.apiKeys.findById(c.req.param("id"));
    if (!existing) throw new ApiError("not_found", "Key not found.");
    const key = existing.revoked_at ? existing : (await deps.repos.apiKeys.update(existing.id, { revoked_at: deps.clock().toISOString() }))!;
    deps.keyAuth.invalidate(key.id);
    await audit(c, "key.revoke", key.id, { prefix: key.prefix });
    return c.json({ key: publicKey(key) });
  });

  // ---- Logs ----
  app.get("/logs", async (c) => {
    const q = logQuerySchema.safeParse(c.req.query());
    if (!q.success) invalid(q.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const filter: LogFilter = q.data;
    const rows = await deps.repos.logs.list(filter);
    return c.json({ logs: rows.map((r) => viewLog(r, false)), can_view_transcripts: c.get("admin").entry.can_view_transcripts, limit: filter.limit, offset: filter.offset });
  });

  app.get("/logs/:id", async (c) => {
    const row = await deps.repos.logs.findById(c.req.param("id"));
    if (!row) throw new ApiError("not_found", "Log entry not found.");
    const canView = c.get("admin").entry.can_view_transcripts;
    if (canView && (row.transcript !== null || row.output !== null)) {
      await audit(c, "log.view_transcript", row.id, { key_id: row.key_id });
    }
    return c.json({ log: viewLog(row, canView) });
  });

  // ---- Allowlist (super_admin) ----
  const superOnly = requireSuperAdmin();
  app.get("/allowlist", superOnly, async (c) => c.json({ entries: await deps.repos.allowlist.list() }));

  app.post("/allowlist", superOnly, async (c) => {
    const input = await parseJson(c, allowlistCreateSchema);
    const email = input.email.toLowerCase();
    if (await deps.repos.allowlist.findByEmail(email)) throw new ApiError("invalid_request", "That email is already on the allowlist.");
    const canView = input.can_view_transcripts ?? input.role === "super_admin";
    const entry = await deps.repos.allowlist.create({ email, role: input.role, can_view_transcripts: canView, invited_by: c.get("admin").email });
    try {
      const userId = await deps.identity.ensureUser(email);
      await deps.repos.allowlist.update(entry.id, { auth_user_id: userId });
      entry.auth_user_id = userId;
    } catch (err) {
      deps.logger.warn("could not provision auth user now; will retry at first login", { email, error: String(err) });
    }
    await audit(c, "allowlist.add", entry.email, { role: entry.role, can_view_transcripts: entry.can_view_transcripts });
    return c.json({ entry }, 201);
  });

  app.patch("/allowlist/:id", superOnly, async (c) => {
    const input = await parseJson(c, allowlistPatchSchema);
    const entry = await deps.repos.allowlist.findById(c.req.param("id"));
    if (!entry) throw new ApiError("not_found", "Allowlist entry not found.");
    const self = entry.email === c.get("admin").email;
    if (self && (input.disabled === true || (input.role && input.role !== "super_admin"))) {
      throw new ApiError("invalid_request", "You cannot disable or demote your own account.");
    }
    if ((input.role === "admin" || input.disabled === true) && entry.role === "super_admin") {
      const supers = (await deps.repos.allowlist.list()).filter((e) => e.role === "super_admin" && !e.disabled_at && e.id !== entry.id);
      if (supers.length === 0) throw new ApiError("invalid_request", "At least one active super-admin must remain.");
    }
    const patch: Record<string, unknown> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.can_view_transcripts !== undefined) patch.can_view_transcripts = input.can_view_transcripts;
    if (input.disabled !== undefined) patch.disabled_at = input.disabled ? deps.clock().toISOString() : null;
    const updated = (await deps.repos.allowlist.update(entry.id, patch))!;
    if (input.disabled === true && entry.auth_user_id) await deps.identity.revokeSessions(entry.auth_user_id).catch(() => {});
    await audit(c, "allowlist.update", entry.email, input);
    return c.json({ entry: updated });
  });

  app.delete("/allowlist/:id", superOnly, async (c) => {
    const entry = await deps.repos.allowlist.findById(c.req.param("id"));
    if (!entry) throw new ApiError("not_found", "Allowlist entry not found.");
    if (entry.email === c.get("admin").email) throw new ApiError("invalid_request", "You cannot remove your own account.");
    if (entry.role === "super_admin") {
      const supers = (await deps.repos.allowlist.list()).filter((e) => e.role === "super_admin" && !e.disabled_at && e.id !== entry.id);
      if (supers.length === 0) throw new ApiError("invalid_request", "At least one active super-admin must remain.");
    }
    await deps.repos.allowlist.remove(entry.id);
    if (entry.auth_user_id) {
      await deps.identity.revokeSessions(entry.auth_user_id).catch(() => {});
      await deps.identity.deleteUser(entry.auth_user_id).catch((e) => deps.logger.warn("auth user delete failed", { email: entry.email, error: String(e) }));
    }
    await audit(c, "allowlist.remove", entry.email);
    return c.json({ ok: true });
  });

  app.post("/allowlist/:id/revoke-sessions", superOnly, async (c) => {
    const entry = await deps.repos.allowlist.findById(c.req.param("id"));
    if (!entry) throw new ApiError("not_found", "Allowlist entry not found.");
    if (entry.auth_user_id) await deps.identity.revokeSessions(entry.auth_user_id);
    await audit(c, "allowlist.revoke_sessions", entry.email);
    return c.json({ ok: true });
  });

  // ---- Quotas ----
  app.get("/quotas", async (c) => {
    const plan = await deps.repos.quotaPlans.get(DEFAULT_PLAN_ID);
    const keys = (await deps.repos.apiKeys.list()).filter((k) => !k.revoked_at);
    return c.json({ plan, overrides: keys.filter((k) => k.monthly_override !== null || k.rps_override !== null).map(publicKey) });
  });

  app.patch("/quotas", async (c) => {
    const input = await parseJson(c, quotaPatchSchema);
    const plan = await deps.repos.quotaPlans.update(DEFAULT_PLAN_ID, input);
    await audit(c, "quota.update", DEFAULT_PLAN_ID, input);
    return c.json({ plan });
  });

  // ---- Settings ----
  app.get("/settings", async (c) => c.json({ settings: await deps.repos.settings.get() }));
  app.patch("/settings", async (c) => {
    const input = await parseJson(c, settingsPatchSchema);
    const settings = await deps.repos.settings.update(input);
    await audit(c, "settings.update", null, input);
    return c.json({ settings });
  });

  // ---- Audit ----
  app.get("/audit", async (c) => c.json({ events: await deps.repos.audit.list(200) }));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err), err.status as any);
    deps.logger.error("admin api error", { path: c.req.path, error: String(err) });
    return c.json(errorBody(new ApiError("internal")), 500);
  });

  return app;
}
