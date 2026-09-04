-- Normalize Phase 1 schema. Applied by `pnpm migrate` (or `supabase db push`).
-- All operational access goes through the `normalize_app` role; anon/authenticated get nothing.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'normalize_app') then
    -- Change this password immediately after the first migration:
    --   alter role normalize_app with password '<strong password>';
    create role normalize_app login password 'change-me-before-deploy';
  end if;
end $$;

create table if not exists allowlist_entries (
  id text primary key,
  email text not null,
  auth_user_id text,
  role text not null check (role in ('super_admin', 'admin')),
  can_view_transcripts boolean not null default false,
  invited_by text,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  last_login_at timestamptz
);
create unique index if not exists allowlist_entries_email_idx on allowlist_entries (lower(email));

create table if not exists quota_plans (
  id text primary key,
  name text not null,
  monthly_requests integer not null check (monthly_requests >= 0),
  rps integer not null check (rps >= 1),
  per_user_monthly integer
);

create table if not exists api_keys (
  id text primary key,
  prefix text not null,
  secret_hash text not null unique,
  name text not null,
  owner_email text,
  notes text,
  created_at timestamptz not null default now(),
  created_by text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  plan_id text not null references quota_plans (id),
  monthly_override integer check (monthly_override is null or monthly_override >= 0),
  rps_override integer check (rps_override is null or rps_override >= 1)
);

create table if not exists quota_usage (
  key_id text not null references api_keys (id) on delete cascade,
  user_id text not null default '',
  period text not null,
  used integer not null default 0,
  topped_up integer not null default 0,
  primary key (key_id, user_id, period)
);

create table if not exists inference_logs (
  id text primary key,
  key_id text references api_keys (id) on delete set null,
  key_prefix text,
  user_id text,
  session_id text,
  app text,
  styling text,
  structure text,
  context text,
  transcript text,
  output text,
  input_chars integer,
  output_chars integer,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  model_revision text,
  status integer not null,
  error_code text,
  ip_hmac text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists inference_logs_created_idx on inference_logs (created_at desc);
create index if not exists inference_logs_key_created_idx on inference_logs (key_id, created_at desc);
create index if not exists inference_logs_user_created_idx on inference_logs (user_id, created_at desc) where user_id is not null;

create table if not exists audit_events (
  id bigserial primary key,
  actor_email text not null,
  action text not null,
  target text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_created_idx on audit_events (created_at desc);

create table if not exists settings (
  key text primary key,
  value jsonb not null
);

create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

-- Row Level Security: enabled everywhere, permissive only for the server role.
do $$
declare t text;
begin
  foreach t in array array['allowlist_entries','quota_plans','api_keys','quota_usage','inference_logs','audit_events','settings','schema_migrations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists normalize_app_all on %I', t);
    execute format('create policy normalize_app_all on %I for all to normalize_app using (true) with check (true)', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on %I to normalize_app', t);
  end loop;
exception when undefined_object then
  -- anon/authenticated do not exist outside Supabase; grants to normalize_app still apply.
  foreach t in array array['allowlist_entries','quota_plans','api_keys','quota_usage','inference_logs','audit_events','settings','schema_migrations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists normalize_app_all on %I', t);
    execute format('create policy normalize_app_all on %I for all to normalize_app using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on %I to normalize_app', t);
  end loop;
end $$;
grant usage, select on sequence audit_events_id_seq to normalize_app;

-- Seed data.
insert into quota_plans (id, name, monthly_requests, rps, per_user_monthly)
values ('default', 'Default', 100, 5, null)
on conflict (id) do nothing;

insert into allowlist_entries (id, email, role, can_view_transcripts, invited_by)
values ('al_seed_super_admin', 'pkling@brainsprung.com', 'super_admin', true, null)
on conflict do nothing;

insert into settings (key, value) values
  ('retention_days', '30'::jsonb),
  ('default_rps', '5'::jsonb),
  ('maintenance_banner', '""'::jsonb),
  ('max_transcript_chars', '2000'::jsonb)
on conflict (key) do nothing;
