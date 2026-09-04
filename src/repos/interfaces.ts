import type {
  AdminRole,
  AllowlistEntry,
  ApiKey,
  AuditEvent,
  InferenceLog,
  QuotaPlan,
  QuotaUsage,
  Settings,
} from "./types.js";

export interface AllowlistRepo {
  findByEmail(email: string): Promise<AllowlistEntry | null>;
  findById(id: string): Promise<AllowlistEntry | null>;
  list(): Promise<AllowlistEntry[]>;
  create(input: { email: string; role: AdminRole; can_view_transcripts: boolean; invited_by: string | null }): Promise<AllowlistEntry>;
  update(id: string, patch: Partial<Pick<AllowlistEntry, "role" | "can_view_transcripts" | "auth_user_id" | "disabled_at" | "last_login_at">>): Promise<AllowlistEntry | null>;
  remove(id: string): Promise<AllowlistEntry | null>;
}

export interface ApiKeyRepo {
  findByHash(hash: string): Promise<ApiKey | null>;
  findById(id: string): Promise<ApiKey | null>;
  list(): Promise<ApiKey[]>;
  create(key: ApiKey): Promise<ApiKey>;
  update(id: string, patch: Partial<Pick<ApiKey, "name" | "notes" | "owner_email" | "monthly_override" | "rps_override" | "revoked_at" | "plan_id">>): Promise<ApiKey | null>;
  touchLastUsed(id: string, at: string): Promise<void>;
}

export interface QuotaPlanRepo {
  get(id: string): Promise<QuotaPlan | null>;
  update(id: string, patch: Partial<Pick<QuotaPlan, "monthly_requests" | "rps" | "per_user_monthly" | "name">>): Promise<QuotaPlan | null>;
}

export interface QuotaUsageRepo {
  /** Atomically increments `used` if `used + topped_up_adjusted < limit`. Returns whether the reservation succeeded and the new/current usage. */
  reserve(keyId: string, userId: string, period: string, limit: number): Promise<{ ok: boolean; used: number; topped_up: number }>;
  release(keyId: string, userId: string, period: string): Promise<void>;
  get(keyId: string, userId: string, period: string): Promise<QuotaUsage | null>;
  listForPeriod(period: string): Promise<QuotaUsage[]>;
}

export interface LogFilter {
  key_id?: string;
  user_id?: string;
  from?: string; // ISO
  to?: string; // ISO
  status?: number;
  limit?: number;
  offset?: number;
}

export interface LogStats {
  requests_today: number;
  errors_today: number;
  p95_latency_ms_today: number | null;
  requests_month: number;
}

export interface InferenceLogRepo {
  insert(row: InferenceLog): Promise<void>;
  list(filter: LogFilter): Promise<InferenceLog[]>;
  findById(id: string): Promise<InferenceLog | null>;
  stats(now: Date): Promise<LogStats>;
}

export interface AuditRepo {
  record(event: Omit<AuditEvent, "id" | "created_at">): Promise<AuditEvent>;
  list(limit: number): Promise<AuditEvent[]>;
}

export interface SettingsRepo {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
}

export interface Repos {
  allowlist: AllowlistRepo;
  apiKeys: ApiKeyRepo;
  quotaPlans: QuotaPlanRepo;
  quotaUsage: QuotaUsageRepo;
  logs: InferenceLogRepo;
  audit: AuditRepo;
  settings: SettingsRepo;
}
