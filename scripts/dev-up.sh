#!/usr/bin/env bash
# Local development stack: Docker Postgres + fake llama-server + the app with a fake identity provider.
#   scripts/dev-up.sh          start everything (idempotent)
#   scripts/dev-up.sh down     stop the app and fake model, keep the database
#   scripts/dev-up.sh reset    stop everything and delete the database container
set -euo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER=normalize-pg
PG_PORT=${PG_PORT:-5432}
APP_PORT=${PORT:-3000}
LLAMA_PORT=${FAKE_LLAMA_PORT:-8080}
export DATABASE_URL="postgres://postgres:dev@127.0.0.1:${PG_PORT}/normalize"
RUN_DIR=.dev
mkdir -p "$RUN_DIR"

stop_bg() {
  for name in app llama; do
    if [[ -f "$RUN_DIR/$name.pid" ]] && kill -0 "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null; then
      kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null || true
      echo "stopped $name"
    fi
    rm -f "$RUN_DIR/$name.pid"
  done
  pkill -f "tsx watch src/index.ts" 2>/dev/null || true
  pkill -f "scripts/fake-llama-server.ts" 2>/dev/null || true
}

case "${1:-up}" in
  down) stop_bg; exit 0 ;;
  reset) stop_bg; docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 && echo "removed $PG_CONTAINER"; exit 0 ;;
  up) ;;
  *) echo "usage: $0 [up|down|reset]"; exit 1 ;;
esac

command -v docker >/dev/null || { echo "docker is required"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is not running. Start Docker Desktop and retry."; exit 1; }
[[ -d node_modules ]] || pnpm install

# 1. Postgres
if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker start "$PG_CONTAINER" >/dev/null
  else
    docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=dev -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
  fi
  echo "started postgres container $PG_CONTAINER"
fi
for _ in $(seq 1 30); do docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$PG_CONTAINER" psql -U postgres -tAc "select 1 from pg_database where datname='normalize'" | grep -q 1 \
  || docker exec "$PG_CONTAINER" psql -U postgres -c "create database normalize;" >/dev/null
pnpm --silent migrate

# 2. Fake model + app
stop_bg
FAKE_LLAMA_PORT=$LLAMA_PORT nohup pnpm --silent fake-llama > "$RUN_DIR/llama.log" 2>&1 &
echo $! > "$RUN_DIR/llama.pid"
PORT=$APP_PORT LLAMA_URL="http://127.0.0.1:${LLAMA_PORT}" PUBLIC_URL="http://localhost:${APP_PORT}" \
IDENTITY_PROVIDER=fake KEY_PEPPER=dev-pepper-dev-pepper IP_HMAC_SECRET=dev-ip-secret-dev-ip \
SESSION_SECRET=dev-session-secret-dev-session-secret-dev \
nohup pnpm --silent dev > "$RUN_DIR/app.log" 2>&1 &
echo $! > "$RUN_DIR/app.pid"

for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${APP_PORT}/healthz" >/dev/null 2>&1; then
    echo
    echo "Normalize is running."
    echo "  Admin console : http://localhost:${APP_PORT}/admin  (sign in as pkling@brainsprung.com)"
    echo "  Magic links   : printed to $RUN_DIR/app.log  ->  scripts/dev-link.sh prints the latest one"
    echo "  Smoke test    : scripts/smoke.sh  (logs in, creates a key, calls the API)"
    echo "  Stop          : scripts/dev-up.sh down"
    exit 0
  fi
  sleep 1
done
echo "app did not become healthy; last log lines:"; tail -20 "$RUN_DIR/app.log"; exit 1
