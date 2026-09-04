# Normalize Phase 1 — Technical Design

**Date:** 2026-09-04  
**Source of truth for product scope:** `Normalize-PRD-v0.3.md` (decisions locked). This document records the engineering design for Phase 1 only.

## 1. Shape of the system

One Node 22 / TypeScript service built on Hono. It serves three surfaces from one process:

| Surface | Path | Auth |
|---|---|---|
| Inference API | `POST /v1/normalize`, `GET /v1/schema` | API key (`Authorization: Bearer nrm_…`) |
| Admin console | `/admin/*` (HTML) and `/admin/api/*` (JSON) | Supabase Auth magic-link session in signed httpOnly cookies + CSRF |
| Ops | `GET /healthz` | none |

Beside it run `llama-server` (llama.cpp, CPU, localhost only) and Caddy (TLS). All three are Docker Compose services on one DigitalOcean Droplet. State lives in Supabase Postgres, reached through the pooler with a dedicated `normalize_app` role.

## 2. Modules

```
src/
  index.ts             boot: config → db → deps → server
  config.ts            zod-validated env
  app.ts               builds the Hono app from a Deps object (testable without network)
  core/                pure logic, no I/O
    errors.ts          ApiError + error codes/http mapping from PRD §6.5
    prompt.ts          system prompt, control line, collision guard, max_new_tokens
    keys.ts            nrm_ key generation, prefix, peppered SHA-256
    period.ts          UTC month period, reset_at
    ids.ts             norm_/key_ ids
  schema/normalize.ts  zod request/response schemas + JSON Schema for /v1/schema
  repos/               persistence interfaces + in-memory fakes + Postgres impls
  services/
    inference.ts       InferenceClient interface; HttpLlamaClient; FakeInferenceClient
    keyAuth.ts         bearer parsing, hash lookup, 60 s cache, revoke invalidation
    quota.ts           monthly reserve/release + per-key RPS sliding window
    normalize.ts       request pipeline (validate → auth → quota → infer → log)
    identity.ts        IdentityProvider interface (Supabase impl + fake)
    adminSession.ts    cookie session encode/decode, 7-day idle / 30-day max, CSRF
  routes/
    v1.ts, health.ts, admin/auth.ts, admin/api.ts, admin/pages.tsx, admin/layout.tsx
  db/client.ts, db/migrate.ts
supabase/migrations/*.sql   schema, RLS, role policies, seed
```

Every I/O boundary (database, llama-server, Supabase Auth, clock) is an interface injected through `Deps`, with an in-memory or fake implementation. Route tests exercise the real Hono app end to end with fakes; Postgres repos have separate integration tests gated on `TEST_DATABASE_URL`.

## 3. Inference request pipeline

1. Reject `Idempotency-Key` header → 400.
2. Parse bearer token. Missing/malformed/unknown → 401. Revoked → 403. Lookup is by peppered SHA-256 of the full key, cached 60 s in memory; admin revoke invalidates the cache entry immediately.
3. Parse JSON body with a strict zod schema (unknown fields rejected, metadata strict, enums with defaults). Transcript trimmed; empty → 400; > `max_transcript_chars` (setting, default 2000) → 413. No model call for any 4xx.
4. RPS check (sliding 1 s window per key, in memory) → 429 `rate_limited` with `retry_after_seconds: 1` and `reset_at`.
5. Monthly quota reserve: atomic `used < limit` conditional increment on `(key_id, period)`. Fail → 429 `quota_exceeded` with `reset_at` = next UTC month. If the call later fails with a non-200, the reservation is released, so only 200 debits quota.
6. Build the prompt: fixed system prompt + `[Styling: x] [Structure: y] [Context: z]\n{transcript}`; transcript that begins with a control-line marker is prefixed with one space.
7. `input_tokens` from llama-server `/tokenize` (falls back to `ceil(chars/3)` if that call fails). Optional token cap: if `/tokenize` succeeded and tokens > 500 → 413 (reservation released). `max_tokens = min(700, ceil(1.3 × input_tokens) + 32)`.
8. `POST /v1/chat/completions` on llama-server with `temperature: 0`, `chat_template_kwargs: {enable_thinking:false}`, 15 s budget. Connection refused / llama 503 → 503; abort on timeout → 504; other errors → 500.
9. Write one `inference_logs` row for every request that got past bearer parsing (including 4xx/5xx), with transcript/output only when a validated body exists. IP stored as HMAC-SHA256.
10. Respond with the PRD §6.4 body.

## 4. Admin identity and sessions

`IdentityProvider` interface: `ensureUser(email)`, `sendMagicLink(email, redirectTo)`, `verifyMagicLink(tokenHash)`, `verifyAccessToken(jwt)`, `refreshSession(refreshToken)`, `revokeSessions(userId)`, `deleteUser(userId)`.

Supabase implementation uses `supabase-js` with the service-role key server-side only. The Supabase magic-link email template must link to `{{ .SiteURL }}/admin/auth/callback?token_hash={{ .TokenHash }}&type=magiclink`; the callback calls `auth.verifyOtp`. Access tokens are verified locally with `jose` (HS256 with `SUPABASE_JWT_SECRET`, or the project JWKS when the secret is not configured).

Login: `POST /admin/auth/login {email}` → rate limit 5/email/hour → allowlist check (active entry) → provision auth user if `auth_user_id` is null → send magic link. Always respond "check your inbox".

Session cookie `nrm_admin` (signed, httpOnly, Secure in prod, SameSite=Lax) holds `{access_token, refresh_token, started_at}`. Every admin request: verify JWT (refresh transparently if expired), reject if `started_at` older than 30 days, re-load the allowlist entry by email (must exist and not be disabled), and re-issue the cookie with a 7-day max-age. CSRF: a second signed cookie `nrm_csrf`; state-changing admin requests must send the same value in `x-csrf-token`. Pages embed it in a `<meta>` tag.

## 5. Data model (Postgres)

`allowlist_entries`, `quota_plans` (seeded `default`: 100/month, 5 rps), `api_keys`, `quota_usage` (pk `key_id, user_id, period` with `user_id` defaulting to `''`), `inference_logs`, `audit_events`, `settings` (jsonb by key: `retention_days`, `default_rps`, `maintenance_banner`, `max_transcript_chars`), `schema_migrations`.

RLS is enabled on every table with no policies for `anon`/`authenticated`. A permissive policy exists only for `normalize_app`. The seed inserts `pkling@brainsprung.com` as `super_admin` with `can_view_transcripts = true`.

## 6. Admin API (JSON, `/admin/api`)

| Method + path | Role | Purpose |
|---|---|---|
| GET `dashboard` | admin | requests today, error rate, p95 latency, quota burn, per-key remaining |
| GET/POST `keys`, GET `keys/:id`, PATCH `keys/:id`, POST `keys/:id/revoke` | admin | key lifecycle; secret returned once on POST |
| GET `logs`, GET `logs/:id` | admin | filters `key_id,user_id,from,to,status`; transcript/output only with `can_view_transcripts`; detail read writes an audit event |
| GET/POST `allowlist`, PATCH/DELETE `allowlist/:id`, POST `allowlist/:id/revoke-sessions` | super_admin | allowlist + role + transcript flag; delete revokes sessions and deletes the auth user |
| GET/PATCH `quotas` | admin | default plan |
| GET/PATCH `settings` | admin | retention_days (7/30/90), default_rps, maintenance_banner, max_transcript_chars |
| GET `audit` | admin | recent audit events |

Every mutation writes an `audit_events` row.

## 7. Error handling

All API errors are `ApiError` instances mapped to the PRD table. Unexpected exceptions become `500 inference_failed` on `/v1` and `500 internal` on admin routes, logged structurally without transcripts or keys. Raw API keys never reach logs: the logger only sees the prefix.

## 8. Testing

- Unit: prompt/collision/max-tokens, key hashing, period math, schema strictness, JSON Schema agreement.
- Route (fakes): every error code in §6.5, quota burn with a 2-request key, 401/403 logging, control-line collision, empty output 200, schema endpoint, health.
- Admin (fakes): allowlist enumeration-safe login, callback → session, CSRF enforcement, role gate, transcript gate + audit, revoke invalidates key immediately, 30-day max session.
- Postgres integration (gated): migrations apply, quota reserve is atomic under concurrency, log filters.

## 9. Deployment

`deploy/docker-compose.yml`: `llama` (ghcr.io/ggml-org/llama.cpp:server, model volume, `--jinja --chat-template-kwargs '{"enable_thinking":false}' --temp 0 --parallel 2`), `api` (this service), `caddy` (TLS, `/v1*` and `/admin*` to api). `.env.example` documents all variables. README covers Supabase project setup (SMTP via Resend, email template, disable signup, app DB role), model download, and first login.
