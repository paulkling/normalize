import type { Context, Structure, Styling } from "../core/prompt.js";

export type AdminRole = "super_admin" | "admin";

export interface AllowlistEntry {
  id: string;
  email: string;
  auth_user_id: string | null;
  role: AdminRole;
  can_view_transcripts: boolean;
  invited_by: string | null;
  created_at: string;
  disabled_at: string | null;
  last_login_at: string | null;
}

export interface QuotaPlan {
  id: string;
  name: string;
  monthly_requests: number;
  rps: number;
  per_user_monthly: number | null;
}

export interface ApiKey {
  id: string;
  prefix: string;
  secret_hash: string;
  name: string;
  owner_email: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  plan_id: string;
  monthly_override: number | null;
  rps_override: number | null;
}

/** Public view of a key: never includes the hash. */
export type ApiKeyPublic = Omit<ApiKey, "secret_hash">;

export interface QuotaUsage {
  key_id: string;
  user_id: string; // '' when not per-user
  period: string; // YYYY-MM
  used: number;
  topped_up: number;
}

export interface InferenceLog {
  id: string;
  key_id: string | null;
  key_prefix: string | null;
  user_id: string | null;
  session_id: string | null;
  app: string | null;
  styling: Styling | null;
  structure: Structure | null;
  context: Context | null;
  transcript: string | null;
  output: string | null;
  input_chars: number | null;
  output_chars: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  model_revision: string | null;
  status: number;
  error_code: string | null;
  ip_hmac: string | null;
  user_agent: string | null;
  created_at: string;
}

/** Log row as returned to admins: transcript/output stripped unless permitted. */
export type InferenceLogView = Omit<InferenceLog, "transcript" | "output"> & {
  transcript?: string | null;
  output?: string | null;
  redacted: boolean;
};

export interface AuditEvent {
  id: number;
  actor_email: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface Settings {
  retention_days: 7 | 30 | 90;
  default_rps: number;
  maintenance_banner: string;
  max_transcript_chars: number;
}

export const DEFAULT_SETTINGS: Settings = {
  retention_days: 30,
  default_rps: 5,
  maintenance_banner: "",
  max_transcript_chars: 2000,
};

export const DEFAULT_PLAN_ID = "default";
