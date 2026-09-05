#!/usr/bin/env bash
# End-to-end smoke test against a running dev stack (scripts/dev-up.sh).
# Signs in through the magic-link flow, creates a key, calls /v1/normalize, and checks the log + audit trail.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=${BASE:-http://localhost:3000}
EMAIL=${EMAIL:-pkling@brainsprung.com}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
j() { python3 -c 'import sys,json; d=json.load(sys.stdin); print(*[eval("d"+k) for k in sys.argv[1:]], sep=" / ")' "$@"; }

step "1. Health"
curl -fsS "$BASE/healthz" || fail "healthz"
echo

step "2. Request a sign-in link for $EMAIL"
CSRF=$(curl -fsS -c "$JAR" -b "$JAR" "$BASE/admin/login" | grep -o 'csrf-token" content="[^"]*' | sed 's/.*content="//')
[[ -n "$CSRF" ]] || fail "no CSRF token on login page"
curl -fsS -c "$JAR" -b "$JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\"}" "$BASE/admin/auth/login" | j "['message']"
sleep 1
LINK=$(scripts/dev-link.sh) || fail "magic link not found in .dev/app.log (is IDENTITY_PROVIDER=fake?)"
echo "magic link: $LINK"

step "3. Follow the link"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -b "$JAR" "$LINK")
[[ "$code" == "302" ]] || fail "callback returned $code"
curl -fsS -b "$JAR" "$BASE/admin/api/me" | j "['email']" "['role']"

step "4. Create an API key"
KEY_JSON=$(curl -fsS -c "$JAR" -b "$JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"smoke-test"}' "$BASE/admin/api/keys")
SECRET=$(echo "$KEY_JSON" | j "['secret']")
KEY_ID=$(echo "$KEY_JSON" | j "['key']['id']")
echo "key $KEY_ID secret ${SECRET:0:8}…"

step "5. Call POST /v1/normalize"
RESP=$(curl -fsS -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"transcript":"um so hello there uh this is a test of the system","styling":"casual","metadata":{"user_id":"smoke"}}' \
  "$BASE/v1/normalize")
echo "$RESP"
LOG_ID=$(echo "$RESP" | j "['id']")

step "6. Rejections"
printf 'unknown field  -> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' -d '{"transcript":"x","system":"evil"}' "$BASE/v1/normalize")"
printf 'no key         -> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"transcript":"x"}' "$BASE/v1/normalize")"
printf 'too long       -> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' -d "{\"transcript\":\"$(printf 'a%.0s' $(seq 1 2001))\"}" "$BASE/v1/normalize")"

step "7. Log detail and audit"
curl -fsS -b "$JAR" "$BASE/admin/api/logs/$LOG_ID" | j "['log']['transcript']" "['log']['output']"
curl -fsS -b "$JAR" "$BASE/admin/api/audit" | python3 -c "import sys,json; print(', '.join(e['action'] for e in json.load(sys.stdin)['events'][:5]))"

step "8. Revoke the key"
curl -fsS -b "$JAR" -H "x-csrf-token: $CSRF" -X POST "$BASE/admin/api/keys/$KEY_ID/revoke" >/dev/null
printf 'after revoke   -> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' -d '{"transcript":"x"}' "$BASE/v1/normalize")"

step "9. Fresh sign-in link for you (the one above was used by this script)"
curl -fsS -c "$JAR" -b "$JAR" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}" "$BASE/admin/auth/login" >/dev/null
sleep 1
echo "All good. Open this in a browser: $(scripts/dev-link.sh)"
