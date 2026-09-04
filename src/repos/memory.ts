import { newEntryId } from "../core/ids.js";
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
  DEFAULT_PLAN_ID,
  DEFAULT_SETTINGS,
  type AllowlistEntry,
  type ApiKey,
  type AuditEvent,
  type InferenceLog,
  type QuotaPlan,
  type QuotaUsage,
  type Settings,
} from "./types.js";

const nowIso = () => new Date().toISOString();

export class MemoryAllowlistRepo implements AllowlistRepo {
  entries = new Map<string, AllowlistEntry>();
  async findByEmail(email: string) {
    const e = email.toLowerCase();
    return [...this.entries.values()].find((x) => x.email === e) ?? null;
  }
  async findById(id: string) {
    return this.entries.get(id) ?? null;
  }
  async list() {
    return [...this.entries.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async create(input: { email: string; role: AllowlistEntry["role"]; can_view_transcripts: boolean; invited_by: string | null }) {
    const email = input.email.toLowerCase();
    if (await this.findByEmail(email)) throw new Error("duplicate email");
    const entry: AllowlistEntry = {
      id: newEntryId(),
      email,
      auth_user_id: null,
      role: input.role,
      can_view_transcripts: input.can_view_transcripts,
      invited_by: input.invited_by,
      created_at: nowIso(),
      disabled_at: null,
      last_login_at: null,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }
  async update(id: string, patch: Partial<AllowlistEntry>) {
    const e = this.entries.get(id);
    if (!e) return null;
    Object.assign(e, patch);
    return e;
  }
  async remove(id: string) {
    const e = this.entries.get(id) ?? null;
    this.entries.delete(id);
    return e;
  }
}

export class MemoryApiKeyRepo implements ApiKeyRepo {
  keys = new Map<string, ApiKey>();
  async findByHash(hash: string) {
    return [...this.keys.values()].find((k) => k.secret_hash === hash) ?? null;
  }
  async findById(id: string) {
    return this.keys.get(id) ?? null;
  }
  async list() {
    return [...this.keys.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async create(key: ApiKey) {
    this.keys.set(key.id, { ...key });
    return key;
  }
  async update(id: string, patch: Partial<ApiKey>) {
    const k = this.keys.get(id);
    if (!k) return null;
    Object.assign(k, patch);
    return k;
  }
  async touchLastUsed(id: string, at: string) {
    const k = this.keys.get(id);
    if (k) k.last_used_at = at;
  }
}

export class MemoryQuotaPlanRepo implements QuotaPlanRepo {
  plans = new Map<string, QuotaPlan>([
    [DEFAULT_PLAN_ID, { id: DEFAULT_PLAN_ID, name: "Default", monthly_requests: 100, rps: 5, per_user_monthly: null }],
  ]);
  async get(id: string) {
    return this.plans.get(id) ?? null;
  }
  async update(id: string, patch: Partial<QuotaPlan>) {
    const p = this.plans.get(id);
    if (!p) return null;
    Object.assign(p, patch);
    return p;
  }
}

export class MemoryQuotaUsageRepo implements QuotaUsageRepo {
  usage = new Map<string, QuotaUsage>();
  private k(keyId: string, userId: string, period: string) {
    return `${keyId}|${userId}|${period}`;
  }
  async reserve(keyId: string, userId: string, period: string, limit: number) {
    const key = this.k(keyId, userId, period);
    const row = this.usage.get(key) ?? { key_id: keyId, user_id: userId, period, used: 0, topped_up: 0 };
    if (row.used >= limit + row.topped_up) {
      this.usage.set(key, row);
      return { ok: false, used: row.used, topped_up: row.topped_up };
    }
    row.used += 1;
    this.usage.set(key, row);
    return { ok: true, used: row.used, topped_up: row.topped_up };
  }
  async release(keyId: string, userId: string, period: string) {
    const row = this.usage.get(this.k(keyId, userId, period));
    if (row && row.used > 0) row.used -= 1;
  }
  async get(keyId: string, userId: string, period: string) {
    return this.usage.get(this.k(keyId, userId, period)) ?? null;
  }
  async listForPeriod(period: string) {
    return [...this.usage.values()].filter((u) => u.period === period);
  }
}

export class MemoryInferenceLogRepo implements InferenceLogRepo {
  rows: InferenceLog[] = [];
  async insert(row: InferenceLog) {
    this.rows.push({ ...row });
  }
  async list(filter: LogFilter) {
    let out = this.rows.filter(
      (r) =>
        (!filter.key_id || r.key_id === filter.key_id) &&
        (!filter.user_id || r.user_id === filter.user_id) &&
        (!filter.from || r.created_at >= filter.from) &&
        (!filter.to || r.created_at <= filter.to) &&
        (filter.status === undefined || r.status === filter.status),
    );
    out = out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const offset = filter.offset ?? 0;
    return out.slice(offset, offset + (filter.limit ?? 50));
  }
  async findById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async stats(now: Date): Promise<LogStats> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const today = this.rows.filter((r) => r.created_at >= dayStart);
    const lat = today.filter((r) => r.status === 200 && r.latency_ms != null).map((r) => r.latency_ms!).sort((a, b) => a - b);
    return {
      requests_today: today.length,
      errors_today: today.filter((r) => r.status >= 500).length,
      p95_latency_ms_today: lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)]! : null,
      requests_month: this.rows.filter((r) => r.created_at >= monthStart).length,
    };
  }
}

export class MemoryAuditRepo implements AuditRepo {
  events: AuditEvent[] = [];
  async record(event: Omit<AuditEvent, "id" | "created_at">) {
    const e: AuditEvent = { ...event, id: this.events.length + 1, created_at: nowIso() };
    this.events.push(e);
    return e;
  }
  async list(limit: number) {
    return [...this.events].reverse().slice(0, limit);
  }
}

export class MemorySettingsRepo implements SettingsRepo {
  settings: Settings = { ...DEFAULT_SETTINGS };
  async get() {
    return { ...this.settings };
  }
  async update(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    return { ...this.settings };
  }
}

export function createMemoryRepos(): Repos & {
  allowlist: MemoryAllowlistRepo;
  apiKeys: MemoryApiKeyRepo;
  quotaPlans: MemoryQuotaPlanRepo;
  quotaUsage: MemoryQuotaUsageRepo;
  logs: MemoryInferenceLogRepo;
  audit: MemoryAuditRepo;
  settings: MemorySettingsRepo;
} {
  return {
    allowlist: new MemoryAllowlistRepo(),
    apiKeys: new MemoryApiKeyRepo(),
    quotaPlans: new MemoryQuotaPlanRepo(),
    quotaUsage: new MemoryQuotaUsageRepo(),
    logs: new MemoryInferenceLogRepo(),
    audit: new MemoryAuditRepo(),
    settings: new MemorySettingsRepo(),
  };
}
