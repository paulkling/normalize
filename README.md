# Normalize

Internal, keyed HTTP service that turns raw English speech-to-text transcripts into clean written text using the
`normalize-v1` model, plus an admin console for API keys, quotas, logs, and the login allowlist.
Product requirements live in `Normalize-PRD-v0.3.md`; the engineering design is in `docs/superpowers/specs/`.

## Layout

| Path | What |
|---|---|
| `src/core` | Pure logic: prompt/control line, key hashing, UTC periods, error codes |
| `src/schema` | Zod request/response schemas and the JSON Schema served at `/v1/schema` |
| `src/services` | Inference client, key auth cache, quotas + RPS, admin sessions, identity (Supabase + fake) |
| `src/repos` | Repository interfaces with Postgres and in-memory implementations |
| `src/routes` | `/v1/*`, `/healthz`, `/admin/*` pages and `/admin/api/*` JSON |
| `supabase/migrations` | Schema, RLS policies, seed super-admin |
| `deploy/` | Docker Compose (llama-server, api, Caddy) and Caddyfile |
| `scripts/fake-llama-server.ts` | Stand-in for llama-server used in tests and local dev |

## Run locally (no Supabase, no model)

```bash
pnpm install
scripts/dev-up.sh        # Docker Postgres + migrations + fake llama-server + app on :3000
scripts/smoke.sh         # signs in, creates a key, calls /v1/normalize, checks logs and audit
scripts/dev-up.sh down   # stop (add `reset` to also delete the database container)
```

To use the console yourself: open http://localhost:3000/admin, enter `pkling@brainsprung.com`, then run
`scripts/dev-link.sh` to print the magic link (fake identity mode logs it instead of sending mail) and open it in the
same browser. Create a key on the API keys page, then:

```bash
curl -s http://localhost:3000/v1/normalize \
  -H "Authorization: Bearer nrm_..." -H "Content-Type: application/json" \
  -d '{"transcript":"um so hello there uh this is a test","styling":"casual"}'
```

### One container instead

`./start.sh` builds `Dockerfile.all-in-one`, which bundles Postgres, the fake model and the app into one image, and runs it
on :3000. Use `CONTAINER=normalize-allinone scripts/dev-link.sh` to read magic links from its log. This is for quick
demos only; it is not the production topology.

## Tests

```bash
pnpm test                       # unit + route tests with fakes (no network)
TEST_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/normalize_test pnpm test   # also Postgres integration
pnpm typecheck
```

The Postgres suite drops and recreates the `public` schema of that database. Point it at a throwaway database.

## Production setup

1. **Supabase project** (region near the Droplet, e.g. US East + `nyc3`).
   - Auth → Providers → Email: enable, **disable "Allow new users to sign up"**, keep magic links, set OTP expiry to 900 s.
   - Auth → SMTP: enable custom SMTP with Resend (`smtp.resend.com:465`, user `resend`, password = Resend API key, from = `noreply@<verified domain>`).
   - Auth → Email templates → Magic Link: set the link to
     `{{ .SiteURL }}/admin/auth/callback?token_hash={{ .TokenHash }}&type=magiclink`
     and set Site URL / Redirect URLs to `PUBLIC_URL`.
   - Database: run the migration with a privileged connection, then set a real password for the app role:
     ```bash
     MIGRATE_DATABASE_URL=... pnpm migrate
     psql "$MIGRATE_DATABASE_URL" -c "alter role normalize_app with password '<strong password>';"
     ```
     RLS is on for every table; only `normalize_app` has a policy. `anon`/`authenticated` have no grants.
2. **Droplet** (Ubuntu 24.04, 4 vCPU / 8 GB to start): install Docker, clone this repo, download the model into
   `models/` (see `models/README.md`), copy `.env.example` to `.env` and fill it in, then:
   ```bash
   cd deploy && docker compose --env-file ../.env up -d --build
   ```
   Caddy obtains TLS for `DOMAIN`. Only ports 80/443 are exposed; llama-server is reachable only inside the Compose network.
3. **First login**: `pkling@brainsprung.com` is seeded as super-admin with transcript access. Sign in at
   `https://<DOMAIN>/admin`, then add other admins on the Allowlist page.
4. **Measure**: after the first week, check p95 on the Dashboard against the §12 target and move to a dedicated-CPU
   Droplet if it misses.

## API contract

`POST /v1/normalize` with `Authorization: Bearer nrm_...`. Body: `transcript` (1–2,000 chars), optional `styling`,
`structure`, `context`, `metadata {user_id, session_id, app}`. Unknown fields are rejected. The full JSON Schema is at
`GET /v1/schema`. Error codes and quota semantics follow PRD §6.5: only HTTP 200 debits the monthly quota.

## Phase 1 scope notes

- Retention is a Phase 2 scheduled job; the setting is stored but not yet enforced.
- Per-user quotas, top-ups, key rotation, charts, and log search are Phase 2.
- The RPS limiter and key cache are in-process; that is correct for the single-box v1 topology.
