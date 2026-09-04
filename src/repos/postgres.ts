import { newEntryId } from "../core/ids.js";
import type { Sql } from "../db/client.js";
import type {
  AllowlistRepo,
  ApiKeyRepo,
  AuditRepo,
  InferenceLogRepo,
  LogFilter,
  LogStats,
  QuotaPlanRepo,
  QuotaUsageRepo,
  Repos,
  SettingsRepo,
} from "./interfaces.js";
import {
  DEFAULT_SETTINGS,
  type AllowlistEntry,
  type ApiKey,
  type AuditEvent,
  type InferenceLog,
  type QuotaPlan,
  type QuotaUsage,
  type Settings,
} from "./types.js";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

function rowToEntry(r: any): AllowlistEntry {
  return { ...r, created_at: iso(r.created_at)!, disabled_at: iso(r.disabled_at), last_login_at: iso(r.last_login_at) };
}
function rowToKey(r: any): ApiKey {
  return { ...r, created_at: iso(r.created_at)!, last_used_at: iso(r.last_used_at), revoked_at: iso(r.revoked_at) };
}
function rowToLog(r: any): InferenceLog {
  return { ...r, created_at: iso(r.created_at)! };
}

export class PgAllowlistRepo implements AllowlistRepo {
  constructor(private readonly sql: Sql) {}
  async findByEmail(email: string) {
    const [r] = await this.sql`select * from allowlist_entries where lower(email) = lower(${email})`;
    return r ? rowToEntry(r) : null;
  }
  async findById(id: string) {
    const [r] = await this.sql`select * from allowlist_entries where id = ${id}`;
    return r ? rowToEntry(r) : null;
  }
  async list() {
    return (await this.sql`select * from allowlist_entries order by created_at`).map(rowToEntry);
  }
  async create(input: { email: string; role: AllowlistEntry["role"]; can_view_transcripts: boolean; invited_by: string | null }) {
    const [r] = await this.sql`insert into allowlist_entries (id, email, role, can_view_transcripts, invited_by)
      values (${newEntryId()}, ${input.email.toLowerCase()}, ${input.role}, ${input.can_view_transcripts}, ${input.invited_by}) returning *`;
    return rowToEntry(r);
  }
  async update(id: string, patch: Partial<AllowlistEntry>) {
    const cols = Object.fromEntries(Object.entries(patch).filter(([k]) => ["role", "can_view_transcripts", "auth_user_id", "disabled_at", "last_login_at"].includes(k)));
    if (Object.keys(cols).length === 0) return this.findById(id);
    const [r] = await this.sql`update allowlist_entries set ${this.sql(cols)} where id = ${id} returning *`;
    return r ? rowToEntry(r) : null;
  }
  async remove(id: string) {
    const [r] = await this.sql`delete from allowlist_entries where id = ${id} returning *`;
    return r ? rowToEntry(r) : null;
  }
}

export class PgApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly sql: Sql) {}
  async findByHash(hash: string) {
    const [r] = await this.sql`select * from api_keys where secret_hash = ${hash}`;
    return r ? rowToKey(r) : null;
  }
  async findById(id: string) {
    const [r] = await this.sql`select * from api_keys where id = ${id}`;
    return r ? rowToKey(r) : null;
  }
  async list() {
    return (await this.sql`select * from api_keys order by created_at desc`).map(rowToKey);
  }
  async create(key: ApiKey) {
    const [r] = await this.sql`insert into api_keys ${this.sql(key as any)} returning *`;
    return rowToKey(r);
  }
  async update(id: string, patch: Partial<ApiKey>) {
    const cols = Object.fromEntries(Object.entries(patch).filter(([k]) => ["name", "notes", "owner_email", "monthly_override", "rps_override", "revoked_at", "plan_id"].includes(k)));
    if (Object.keys(cols).length === 0) return this.findById(id);
    const [r] = await this.sql`update api_keys set ${this.sql(cols)} where id = ${id} returning *`;
    return r ? rowToKey(r) : null;
  }
  async touchLastUsed(id: string, at: string) {
    await this.sql`update api_keys set last_used_at = ${at} where id = ${id}`;
  }
}

export class PgQuotaPlanRepo implements QuotaPlanRepo {
  constructor(private readonly sql: Sql) {}
  async get(id: string) {
    const [r] = await this.sql<QuotaPlan[]>`select * from quota_plans where id = ${id}`;
    return r ?? null;
  }
  async update(id: string, patch: Partial<QuotaPlan>) {
    const cols = Object.fromEntries(Object.entries(patch).filter(([k]) => ["name", "monthly_requests", "rps", "per_user_monthly"].includes(k)));
    if (Object.keys(cols).length === 0) return this.get(id);
    const [r] = await this.sql<QuotaPlan[]>`update quota_plans set ${this.sql(cols)} where id = ${id} returning *`;
    return r ?? null;
  }
}

export class PgQuotaUsageRepo implements QuotaUsageRepo {
  constructor(private readonly sql: Sql) {}
  /** Single statement, so concurrent callers cannot both pass the limit check. */
  async reserve(keyId: string, userId: string, period: string, limit: number) {
    const [r] = await this.sql<{ used: number; topped_up: number }[]>`
      insert into quota_usage (key_id, user_id, period, used, topped_up)
      values (${keyId}, ${userId}, ${period}, 1, 0)
      on conflict (key_id, user_id, period) do update
        set used = quota_usage.used + 1
        where quota_usage.used < ${limit} + quota_usage.topped_up
      returning used, topped_up`;
    if (r) {
      if (limit <= 0 && r.used === 1 && r.topped_up === 0) {
        // Fresh row inserted with used=1 despite a zero limit: undo.
        await this.release(keyId, userId, period);
        return { ok: false, used: 0, topped_up: 0 };
      }
      return { ok: true, used: r.used, topped_up: r.topped_up };
    }
    const cur = await this.get(keyId, userId, period);
    return { ok: false, used: cur?.used ?? 0, topped_up: cur?.topped_up ?? 0 };
  }
  async release(keyId: string, userId: string, period: string) {
    await this.sql`update quota_usage set used = greatest(0, used - 1) where key_id = ${keyId} and user_id = ${userId} and period = ${period}`;
  }
  async get(keyId: string, userId: string, period: string) {
    const [r] = await this.sql<QuotaUsage[]>`select * from quota_usage where key_id = ${keyId} and user_id = ${userId} and period = ${period}`;
    return r ?? null;
  }
  async listForPeriod(period: string) {
    return this.sql<QuotaUsage[]>`select * from quota_usage where period = ${period}`;
  }
}

export class PgInferenceLogRepo implements InferenceLogRepo {
  constructor(private readonly sql: Sql) {}
  async insert(row: InferenceLog) {
    await this.sql`insert into inference_logs ${this.sql(row as any)}`;
  }
  async list(filter: LogFilter) {
    const sql = this.sql;
    const rows = await sql`select * from inference_logs
      where true
      ${filter.key_id ? sql`and key_id = ${filter.key_id}` : sql``}
      ${filter.user_id ? sql`and user_id = ${filter.user_id}` : sql``}
      ${filter.from ? sql`and created_at >= ${filter.from}` : sql``}
      ${filter.to ? sql`and created_at <= ${filter.to}` : sql``}
      ${filter.status !== undefined ? sql`and status = ${filter.status}` : sql``}
      order by created_at desc
      limit ${filter.limit ?? 50} offset ${filter.offset ?? 0}`;
    return rows.map(rowToLog);
  }
  async findById(id: string) {
    const [r] = await this.sql`select * from inference_logs where id = ${id}`;
    return r ? rowToLog(r) : null;
  }
  async stats(now: Date): Promise<LogStats> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [r] = await this.sql<{ requests_today: number; errors_today: number; p95: number | null; requests_month: number }[]>`
      select
        count(*) filter (where created_at >= ${dayStart})::int as requests_today,
        count(*) filter (where created_at >= ${dayStart} and status >= 500)::int as errors_today,
        (percentile_cont(0.95) within group (order by latency_ms) filter (where created_at >= ${dayStart} and status = 200 and latency_ms is not null))::int as p95,
        count(*)::int as requests_month
      from inference_logs where created_at >= ${monthStart}`;
    return { requests_today: r?.requests_today ?? 0, errors_today: r?.errors_today ?? 0, p95_latency_ms_today: r?.p95 ?? null, requests_month: r?.requests_month ?? 0 };
  }
}

export class PgAuditRepo implements AuditRepo {
  constructor(private readonly sql: Sql) {}
  async record(event: Omit<AuditEvent, "id" | "created_at">) {
    const [r] = await this.sql`insert into audit_events (actor_email, action, target, details)
      values (${event.actor_email}, ${event.action}, ${event.target}, ${event.details ? this.sql.json(event.details as any) : null}) returning *`;
    return { ...(r as any), id: Number(r!.id), created_at: iso(r!.created_at)! } as AuditEvent;
  }
  async list(limit: number) {
    return (await this.sql`select * from audit_events order by id desc limit ${limit}`).map((r: any) => ({ ...r, id: Number(r.id), created_at: iso(r.created_at)! }) as AuditEvent);
  }
}

export class PgSettingsRepo implements SettingsRepo {
  constructor(private readonly sql: Sql) {}
  async get(): Promise<Settings> {
    const rows = await this.sql<{ key: string; value: unknown }[]>`select key, value from settings`;
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
    return out as unknown as Settings;
  }
  async update(patch: Partial<Settings>): Promise<Settings> {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
      await this.sql`insert into settings (key, value) values (${k}, ${this.sql.json(v as any)}) on conflict (key) do update set value = excluded.value`;
    }
    return this.get();
  }
}

export function createPostgresRepos(sql: Sql): Repos {
  return {
    allowlist: new PgAllowlistRepo(sql),
    apiKeys: new PgApiKeyRepo(sql),
    quotaPlans: new PgQuotaPlanRepo(sql),
    quotaUsage: new PgQuotaUsageRepo(sql),
    logs: new PgInferenceLogRepo(sql),
    audit: new PgAuditRepo(sql),
    settings: new PgSettingsRepo(sql),
  };
}
