#!/usr/bin/env bash
set -euo pipefail

PG_MAJOR="$(ls /etc/postgresql | head -n1)"
if [[ -z "${PG_MAJOR}" ]]; then
  echo "PostgreSQL installation not found"
  exit 1
fi

pg_ctlcluster "${PG_MAJOR}" main start

su - postgres -c "psql -v ON_ERROR_STOP=1 <<'SQL'
DO
\$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'dev';
  ELSE
    ALTER ROLE postgres WITH PASSWORD 'dev';
  END IF;
END
\$\$;
SQL"

su - postgres -c "psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE normalize'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'normalize')\gexec
SQL"

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:dev@127.0.0.1:5432/normalize}"

cd /app
pnpm migrate

pnpm fake-llama &

exec pnpm start