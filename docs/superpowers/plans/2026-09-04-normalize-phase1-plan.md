# Normalize Phase 1 — Implementation Plan

Spec: `docs/superpowers/specs/2026-09-04-normalize-phase1-design.md`

Each task is TDD: write failing tests, implement, run `pnpm test`, commit.

1. **Scaffold** — package.json, tsconfig, vitest, .gitignore, folders. ✔ when `pnpm test` runs (0 tests).
2. **Core** — `core/errors.ts`, `core/prompt.ts`, `core/keys.ts`, `core/period.ts`, `core/ids.ts`, `schema/normalize.ts`. Tests: control line, collision guard, max tokens, key format/hash, period/reset_at, strict schema, JSON schema export.
3. **Repos** — interfaces + in-memory fakes (`repos/memory.ts`). Types for all entities. No tests beyond usage in later tasks.
4. **Inference client** — `services/inference.ts` interface, `HttpLlamaClient` (tokenize + chat, timeout → 504, refused/503 → 503), `FakeInferenceClient`. Tests use a local fake HTTP server.
5. **Key auth + quota** — `services/keyAuth.ts` with cache and invalidation; `services/quota.ts` monthly reserve/release + RPS window. Tests.
6. **Normalize route** — `services/normalize.ts` + `routes/v1.ts` + `routes/health.ts` + `app.ts`. Tests for every error code, logging, schema endpoint, health.
7. **Identity + sessions** — `services/identity.ts` (interface, Supabase impl, fake), `services/adminSession.ts` (cookie codec, CSRF). Tests for session limits and CSRF.
8. **Admin auth routes** — login (rate limit, allowlist, no enumeration), callback, logout. Tests.
9. **Admin API** — keys, logs (gated + audit), allowlist (super_admin), quotas, settings, dashboard, audit. Tests.
10. **Admin pages** — layout + pages in Hono JSX, vanilla JS for actions, CSRF meta tag. Smoke tests render pages.
11. **Postgres** — migrations SQL, `db/client.ts`, `db/migrate.ts`, `repos/postgres.ts`. Integration tests against Docker Postgres.
12. **Boot + deploy** — `config.ts`, `index.ts`, Dockerfile, compose, Caddyfile, `.env.example`, README, LICENSE/NOTICE placeholders for the weights.
13. **Verify** — typecheck, full test run, boot the service against fake llama + Docker Postgres, exercise the API with curl.
