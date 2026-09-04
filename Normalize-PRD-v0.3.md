# Normalize — Product Requirements Document

**Status:** Draft v0.3 — scope decisions locked, contract reconciled  
**Version:** 0.3  
**Date:** 4 September 2026  
**Owner:** Paul  
**Audience:** Internal product, engineering, and ops  
**Classification:** Confidential — internal only

| Field | Value |
|---|---|
| Product / model name | Normalize (`normalize-v1`) |
| Client | Any server-side HTTP caller (TypeScript backends are the first consumers) |
| Audience | Internal only — one workspace |
| Cloud | DigitalOcean (inference/API) + Supabase (Auth/Postgres) |
| Email | Resend via Supabase Auth custom SMTP |
| Seed super-admin | `pkling@brainsprung.com` |
| Default quota | 100 requests / key / UTC month |

---

## 1. Summary

Normalize is an internal-only service (single workspace) that exposes a text-normalization model behind a simple HTTP API. Calling applications send a raw English speech-to-text transcript plus three style controls and receive a single cleaned string. There is no streaming. Keys are issued to internal apps and teammates, not to external partners.

Operators use a small admin site. Only emails on an allowlist can request a login link. Once signed in, an admin can create API keys, attach monthly quotas to a key (and, in Phase 2, to a consuming user), inspect usage, and read request logs. Reading the raw transcript inside a log row is a separate, audited permission.

The model is a 0.6B causal LM fine-tuned only to normalize ASR text. It is not a chatbot. The product must never expose a free-form chat interface.

---

## 2. Problem

Raw ASR output is hard to use in products: fillers, false starts, missing punctuation, spoken numbers, and informal casing. The model already solves that job locally. This product makes the same transformation available as a shared, keyed service so backends can call it without embedding llama.cpp in every app.

Without keys, quotas, and an audit log, a shared inference box cannot be given to multiple teams safely.

Typical inputs are short dictation — roughly 50–100 words. Limits, latency targets, and hosting below are sized for that.

---

## 3. Goals and non-goals

### Goals

- Ship a synchronous `POST` API that returns cleaned English text in one response.
- Host the model ourselves on DigitalOcean, CPU only.
- Give admins a web console to mint, revoke, and label API keys.
- Enforce per-key quotas (per-user quotas in Phase 2); reject over-quota requests with a clear error.
- Log every request, including the raw transcript, controls, output, latency, and key identity.
- Restrict admin login to an allowlist. Login is email magic-link only — no passwords.
- Preserve the model's required system prompt, control line, and greedy decoding exactly as the model was trained.

### Non-goals (v1)

- Streaming tokens or SSE.
- Languages other than English.
- Audio in / speech recognition. Callers already have a transcript.
- Public self-serve signup or a developer marketplace.
- General chat, RAG, or instruction following.
- SSO / Google / GitHub OAuth (can add later).
- End-user UI for dictation. This is infrastructure.
- Multi-region active-active. One region is enough.
- External partner keys.
- A published client SDK. Callers use the documented JSON contract directly.
- Test/live key environments. One environment in v1.
- GPU inference.

---

## 4. Users

| Actor | Needs | Does not |
|---|---|---|
| Consuming service | A stable HTTPS endpoint, API key, documented JSON schema, predictable latency | Log into the admin site |
| Admin operator | Mint/revoke keys, set quotas, inspect logs and usage | Change model weights from the UI; read raw transcripts unless granted |
| Super-admin | Same as admin plus manage the allowlist and grant transcript access | Serve inference from the browser |
| End speaker | Nothing — they never see this product | Authenticate to Normalize |

---

## 5. Product principles

- **Narrow surface.** One inference route. No chat completions in the public contract.
- **Fail closed.** Unknown key, disabled key, over quota, or oversized input is a 4xx, not a silent pass.
- **Transcripts are sensitive.** Logs are access-controlled, retained on a defined schedule, and never used to train.
- **The model does one job.** The API constructs the official control line; callers cannot inject a system prompt.
- **Keep infra cheap.** 0.6B Q4 GGUF runs on CPU. GPU is out of scope.
- **Ship what's in the phase.** Anything tagged Phase 2/3 is not built in MVP, even if the schema anticipates it.

---

## 6. Inference API

### 6.1 Endpoint

```
POST /v1/normalize
Authorization: Bearer nrm_…
Content-Type: application/json
```

No idempotency support in v1. If an `Idempotency-Key` header is sent, the service returns `400 invalid_request` rather than silently ignoring it. Idempotency is Phase 3.

### 6.2 Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `transcript` | string | Yes | Raw ASR text. 1–2,000 characters after trimming. Reject empty/whitespace. |
| `styling` | enum | No | `casual` \| `semi-casual` \| `semi-formal` \| `formal`. Default: `semi-formal` |
| `structure` | enum | No | `prose` \| `lists`. Default: `prose` |
| `context` | enum | No | `general` \| `email`. Default: `general` |
| `metadata` | object | No | Exactly three optional string fields: `user_id`, `session_id`, `app`. Each ≤ 128 chars. Unknown fields are rejected with 400. Stored on the log row. |

Unknown top-level fields (including anything resembling `system`, `prompt`, or `messages`) are rejected with `400 invalid_request`.

### 6.3 Server-side mapping (not caller-visible)

The service always applies the required system prompt verbatim (see Appendix), then builds:

```
[Styling: {styling}] [Structure: {structure}] [Context: {context}]
{transcript}
```

Generation settings are fixed: temperature `0`, no sampling, thinking disabled. `max_new_tokens` is computed per request as `ceil(1.3 × input_tokens) + 32`, with a hard ceiling of 700.

**Size limits.** The 2,000-character cap is enforced in the API layer before any model call and returns `413`. Optionally, the API may also call llama-server's `/tokenize` endpoint and reject inputs over 500 tokens with `413`; if that check is not implemented, the character cap alone applies. No automatic chunking in v1.

**Control-line collision.** If the trimmed transcript begins with `[Styling:`, `[Structure:`, or `[Context:`, the service prefixes it with a single space before insertion so it cannot be parsed as a second control line. This is covered by a test case (§14).

### 6.4 Success response — 200

```json
{
  "id": "norm_…",
  "text": "Cleaned output only.",
  "usage": {
    "input_chars": 184,
    "output_chars": 92,
    "latency_ms": 1240
  },
  "model": "normalize-v1",
  "model_revision": "q4_k_m-2026-08",
  "quota": {
    "key": { "remaining": 81, "reset_at": "2026-10-01T00:00:00Z" }
  }
}
```

An empty `text` string is a valid result (filler-only input) and returns 200.

When a `metadata.user_id` is supplied and per-user quotas are enabled (Phase 2), the response adds `quota.user` with the same shape.

### 6.5 Errors

| HTTP | Code | When | Debits quota |
|---|---|---|---|
| 400 | `invalid_request` | Missing transcript, bad enum, unknown field, bad metadata, empty body, `Idempotency-Key` present | No |
| 401 | `unauthorized` | Missing, malformed, or unrecognized bearer token | No |
| 403 | `forbidden` | Revoked key | No |
| 413 | `payload_too_large` | Transcript over limit | No |
| 429 | `quota_exceeded` | Monthly key (or user) quota exhausted | No |
| 429 | `rate_limited` | Per-key RPS cap hit | No |
| 500 | `inference_failed` | Model process error | No |
| 503 | `unavailable` | Model warming or host down | No |
| 504 | `timeout` | Model exceeded the server budget | No |

Only 200 debits quota (1 request).

Error body:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "Monthly request quota exhausted.",
    "reset_at": "2026-10-01T00:00:00Z"
  }
}
```

`reset_at` is present on `quota_exceeded` and `rate_limited`; `retry_after_seconds` is present on `rate_limited`, `503`, and `504`.

### 6.6 Caller guidance

Callers use plain HTTPS with the JSON contract above. A JSON Schema for the request and response bodies is published alongside the service (`/v1/schema`). Recommended client timeout: 15 s. No SDK is published or maintained.

---

## 7. Admin console

A simple authenticated web app. Desktop-first. Not a public marketing site.

### 7.1 Access model

1. An allowlist table of emails. Only those addresses may request a login link.
2. Login flow: enter email → the Hono server checks the allowlist → if allowlisted, Supabase Auth sends a one-time magic link valid 15 minutes → the callback exchanges the code for a Supabase session stored in `httpOnly`, `Secure`, `SameSite=Lax` cookies (7-day inactivity timeout, 30-day maximum lifetime).
3. If the email is not allowlisted, the server returns the same "check your inbox" response (no enumeration) and does not call Supabase Auth.
4. No passwords. No social login.
5. Roles: `super_admin` (manage allowlist + everything) and `admin` (keys, quotas, logs).
6. Transcript access is a per-entry flag, `can_view_transcripts`, independent of role. Default: on for `super_admin`, off for `admin`. Only a `super_admin` can change it.
7. All state-changing admin requests carry a CSRF token.
8. Sessions can be revoked from the console through the Supabase Auth admin API.
9. Seed super-admin: `pkling@brainsprung.com`.
10. Every admin request validates the Supabase access token and re-checks the allowlist entry so removing or disabling an entry takes effect immediately.
11. Adding an allowlist entry provisions the corresponding Supabase Auth user through the server-side admin API; removing an entry revokes that user's sessions and blocks future login.

### 7.2 Screens

| Screen | Purpose | Phase |
|---|---|---|
| Sign in | Email field + send magic link | 1 |
| Dashboard | Requests today, quota burn, error rate, p95 latency | 1 (numbers), 2 (charts) |
| API keys | Create, label, status, last used, revoke, reveal once | 1 |
| Key detail | Quota, usage, recent requests | 1; rotate secret in 2 |
| Logs | Request log with filters; raw transcript shown only if `can_view_transcripts` | 1; search in 2 |
| Allowlist | Add/remove admin emails, role, transcript flag, last login | 1 |
| Quotas | Default plan + per-key overrides | 1 |
| Users / consumers | Per-user quota view keyed on `metadata.user_id` | 2 |
| Settings | Retention days, default RPS, maintenance banner | 1 |

### 7.3 API keys

- Format: `nrm_<32 random base62 chars>`. Single environment.
- Store only a hash (SHA-256 with a server-side pepper; the key already has 190+ bits of entropy, so argon2id is unnecessary and slows lookup). Show the secret once at creation. Prefix (`nrm_abcd…`) stays visible.
- Fields: name, owner email, notes, created_at, last_used_at, revoked_at, plan_id, overrides.
- Actions (Phase 1): create, revoke (immediate).
- Actions (Phase 2): rotate — new secret issued, old secret valid for 1 hour unless "revoke now."

### 7.4 Quotas

Quotas exist so the admin site can cap cost and abuse. Enforcement is server-side on every inference request.

| Dimension | Default | Configurable per key? | Phase |
|---|---|---|---|
| Requests / calendar month (UTC) | **100** | Yes | 1 |
| Hard RPS per key | 5 | Yes | 1 |
| Max transcript chars | 2,000 | Global setting | 1 |
| Requests / user / month (via `metadata.user_id`) | 100 | Yes | 2 |
| Characters in / month | Off | Later | — |

Per-key monthly quota and per-key RPS are the only v1 controls. A separate rolling-window burst limit is intentionally not included; RPS covers it.

**Per-user quotas (Phase 2).** If `metadata.user_id` is present, the service also enforces a monthly cap for that id across all keys in the workspace. If omitted, only the key quota applies. When either quota is exhausted, return `429 quota_exceeded`.

**Top-ups (Phase 2).** Admins can add N requests to the current period without changing the plan. Top-ups are audited.

### 7.5 Logging

Every normalize call writes one log row:

- `request_id`, timestamp, key prefix, `key_id`, consumer `user_id` (if any)
- styling, structure, context
- raw transcript (full text)
- output text
- input/output char counts, input/output token counts (if available), `latency_ms`, `model_revision`
- HTTP status, error code if any
- caller IP (HMAC-SHA256 with a server secret, not a bare hash) and user-agent

Admin log viewer (Phase 1): filter by key, `user_id`, date, status. Transcript and output columns are rendered only for sessions with `can_view_transcripts`. Viewing a transcript writes an audit event (who, when, `request_id`).

Full-text search on transcript (Phase 2): Supabase Postgres `tsvector` on the transcript column. This is possible because transcripts are stored as plaintext columns in an encrypted database, not as application-encrypted columns (see §10).

**Retention.** Default 30 days, configurable 7 / 30 / 90. A scheduled Supabase Postgres job nulls `transcript` and `output` on rows older than the window; the row itself, its counters, and its status are kept indefinitely so usage history survives. The retention job is Phase 2; until it ships, retention is manual.

Logs live in the Supabase project region. Choose the project region closest to the DigitalOcean Droplet; no additional residency rule applies.

---

## 8. Hosting

The Q4_K_M GGUF is ~462 MB and is designed for CPU. GPU is out of scope.

### v1 topology (DigitalOcean + Supabase)

- **Inference:** llama.cpp `llama-server` serving the Q4_K_M GGUF, `--jinja --chat-template-kwargs '{"enable_thinking":false}' --temp 0`, 2–4 parallel slots. Bind to localhost only.
- **API + admin:** one TypeScript service on Hono / Node 22. Supabase Auth handles admin identity and sessions; Hono owns API-key authentication, authorization, quotas, logging, and proxying to llama-server.
- **Database:** Supabase Postgres. The Hono service connects over TLS through the Supabase connection pooler using a dedicated least-privileged database role. The browser never accesses operational tables directly.
- **Auth:** Supabase Auth with email magic links only. Public signup is disabled; Hono provisions allowlisted users through the server-side admin API and requests magic links only for active allowlist entries.
- **Mail:** Resend configured as Supabase Auth custom SMTP. The from-address uses a domain verified in Resend.
- **Compute:** start on one Droplet, 4 vCPU / 8 GB RAM, Ubuntu 24.04. Measure p95 on a 100-word sample set in the first week. If it misses the §12 target, move to a dedicated-CPU Droplet (e.g. 8 vCPU CPU-Optimized) before touching anything else. Budget: $24–48/month shared or ~$84–168/month dedicated, plus the selected Supabase plan.
- **Edge:** Caddy for TLS.
- **Packaging:** Docker Compose on the Droplet running API, inference, and Caddy.

### When to change

| Signal | Move to |
|---|---|
| p95 latency over target on 100-word inputs | Dedicated-CPU Droplet with more cores |
| Sustained > 4 concurrent generations | Second inference container + queue |
| Need burst to zero when idle | Serverless CPU wrapper around the same GGUF |
| Compliance needs private network only | Droplet in a VPC + trusted sources only |

Do not use a public multi-tenant LLM gateway. Transcript privacy is the whole point of self-hosting.

---

## 9. Data model (logical)

| Entity | Key fields |
|---|---|
| Supabase `auth.users` | Supabase-managed admin identity, email, login timestamps, and session state |
| `AllowlistEntry` | email, auth_user_id?, role, can_view_transcripts, invited_by, created_at, disabled_at |
| `ApiKey` | id, prefix, secret_hash, name, owner_email, notes, created_at, last_used_at, revoked_at, plan_id, monthly_override?, rps_override? |
| `QuotaPlan` | id, name, monthly_requests, rps, per_user_monthly (Phase 2) |
| `QuotaUsage` | key_id, user_id?, period (`YYYY-MM`), used, topped_up |
| `InferenceLog` | id, key_id, user_id?, controls, metadata, transcript?, output?, status, error_code?, latency_ms, model_revision, created_at |
| `AuditEvent` | actor_email, action, target, created_at |

`QuotaPlan` is a template. Per-key overrides live on `ApiKey` and win over the plan.

---

## 10. Security and compliance

- TLS everywhere. HSTS on the admin host.
- Supabase Auth owns magic-link generation, hashing, expiry, single-use validation, and session revocation.
- API keys hashed at rest with a server-side pepper; raw secret shown once.
- Admin app and inference API may share a domain with path split (`/admin` vs `/v1`) or be separate subdomains.
- Rate-limit magic-link issuance (5 / email / hour) and the sign-in page.
- Supabase's publishable key may be present in the browser; the secret/service-role key and database credentials must never be shipped to it.
- Enable Row Level Security on all application tables and grant no direct `anon` or `authenticated` access to keys, quotas, logs, or audit events. All operational data access goes through Hono using a dedicated server-side database role.
- Logs contain user speech. Rely on Supabase Postgres encryption at rest; do not encrypt transcript columns in the application (it breaks search and adds key-management burden). Restrict `SELECT` on `InferenceLog.transcript` / `.output` to the server-side role; the admin API enforces `can_view_transcripts` and audits every read.
- No training on logs. State this in the admin settings footer and any internal terms.
- Do not log full API keys. Do not send transcripts to third-party APM by default.
- Licensing: the upstream model's `LICENSE` and `NOTICE` files are retained in the repository alongside the weights. No model attribution appears in the API, admin UI, or product name.

---

## 11. Functional requirements

1. **FR-1** Given a valid key and a non-empty English transcript, the API returns cleaned text and HTTP 200 within the timeout.
2. **FR-2** The service injects the required system prompt and control line. Callers cannot override them; unknown JSON fields are rejected.
3. **FR-3** Invalid enums, empty transcript, or over-limit transcript return 4xx and do not call the model.
4. **FR-4** Unknown or revoked keys return 401/403 and are logged without treating the body as a successful normalize.
5. **FR-5** Over-quota keys return 429 with `reset_at` set to the next UTC month boundary.
6. **FR-6** Admins on the allowlist receive a Supabase Auth magic link delivered through Resend and can open the console.
7. **FR-7** Non-allowlisted emails cannot obtain a session.
8. **FR-8** Super-admin can add and remove allowlist emails, assign roles, and toggle `can_view_transcripts`.
9. **FR-9** Admin can create a named key, copy the secret once, set monthly quota and RPS, and revoke.
10. **FR-10** An admin with `can_view_transcripts` can open a request and read the raw transcript; that view is audit-logged. An admin without it sees the row with transcript and output redacted.
11. **FR-11** Usage dashboard shows requests and quota remaining for each key in the current UTC month.
12. **FR-12** A JSON Schema for request and response bodies is served at `/v1/schema` and matches the running contract.
13. **FR-13** An empty model output is returned as `text: ""` with HTTP 200 and debits quota.

---

## 12. Non-functional requirements

| Area | v1 target |
|---|---|
| Latency | p50 < 2 s, p95 < 4 s for 100-word (~140-token) transcripts on the launch Droplet. Re-measured after any hosting change. |
| Availability | 99% monthly for a single-box deploy; no multi-AZ required |
| Timeout | 15 s server budget; `504 timeout` if the model exceeds it |
| Throughput | ≥ 2 concurrent generations on the launch Droplet without breaching the latency target |
| Key lookup | < 10 ms from Supabase Postgres + in-memory cache with 60 s TTL |
| Admin UX | Usable at 1280×800; no mobile-specific layout required |
| Observability | Structured logs, `/healthz` (checks llama-server reachability), basic host metrics |

---

## 13. Delivery phases

### Phase 1 — MVP

- llama-server + `POST /v1/normalize` + key auth + monthly quota + RPS cap + Supabase Postgres logs.
- Admin: Supabase Auth magic-link login delivered through Resend, allowlist seeded with `pkling@brainsprung.com` as `super_admin`, `can_view_transcripts` flag, key create/revoke, default quota 100/month, log list with filters + gated transcript detail + audit.
- `/v1/schema`. One DigitalOcean Droplet + one Supabase project + Resend custom SMTP. English. No streaming.

### Phase 2

- Per-user quotas via `metadata.user_id`, top-ups, dashboard charts, log full-text search, key rotation, retention job.

### Phase 3

- Second inference replica + queue, idempotency store, log export, SSO if needed.

---

## 14. Success metrics

- MVP usable end-to-end: allowlisted email → magic link → create key → POST → cleaned text → row in logs.
- Quota rejection works in a test that burns a key limited to 2 requests.
- Zero prompt-injection path: extra `system` / `messages` fields in JSON return 400; a transcript beginning with `[Styling: casual]` is normalized as text, not parsed as a control line.
- p50 / p95 targets met on a 100-word sample set of at least 200 transcripts.
- An `admin` without `can_view_transcripts` cannot retrieve transcript text via the UI or the admin API.
- No raw API key written to application logs.

---

## 15. Decisions locked

- Internal only. No partner or public keys in v1.
- One workspace. No multi-tenant orgs. One key environment.
- Default quota: **100 requests per key per UTC calendar month**. Character billing off.
- Logs live in Supabase Postgres. Place the Supabase project near the DigitalOcean Droplet; no extra residency rule.
- Seed super-admin: `pkling@brainsprung.com`.
- `metadata.user_id` is optional; per-user quota is Phase 2 and only applies when the caller sends it.
- Transcript cap: 2,000 characters. `413` above that. No auto-chunking.
- CPU only. No GPU path.
- No published client SDK. JSON contract + `/v1/schema` only.
- No model attribution in product surfaces. Product and model name is Normalize / `normalize-v1`.
- Auth/database: Supabase. Mail vendor: Resend via Supabase custom SMTP. Compute: DigitalOcean. Framework: Hono on Node 22.

### Still to confirm

- Resend sending domain and from-address (recommend `noreply@` on a domain you already own).
- Supabase project region and nearby Droplet region (for example, Supabase US East + DigitalOcean `nyc3`).
- Supabase plan; the chosen plan must support the required Auth session controls and production database capacity.

---

## 16. Appendix — model constraints (engineering reference)

The upstream weights are a 0.6B causal LM fine-tuned from Qwen3-0.6B, obtained from the Hugging Face repo `superwhisper/s1-mini-GGUF` (Q4_K_M, ≈462 MiB). This appendix is the only place the upstream name appears; the product refers to the model as `normalize-v1` everywhere else.

The model rewrites raw ASR into clean written English: drops fillers, resolves self-corrections, adds punctuation/casing, renders spoken numbers, dates, times, currency, and emails. It will not answer questions, add facts, or follow arbitrary instructions. Recommended input is up to ~1,000 tokens; v1 caps well below that. Filler-only input correctly produces an empty string.

Serve with thinking disabled via the chat template (`--jinja --chat-template-kwargs '{"enable_thinking":false}'`, not `--reasoning-budget 0`) and greedy decoding (`--temp 0`). Size `max_new_tokens` to `1.3 × input_tokens + 32`.

Required system prompt (do not edit):

> You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.
