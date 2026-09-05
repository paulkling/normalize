#!/usr/bin/env bash
# Prints the most recent magic link the dev server logged (fake identity mode).
cd "$(dirname "$0")/.."
# Reads .dev/app.log from scripts/dev-up.sh, or the container log when the all-in-one image is running.
# Set CONTAINER=normalize-allinone to read from a container instead.
src() { if [[ -n "${CONTAINER:-}" ]]; then docker logs "$CONTAINER" 2>&1; elif [[ -f .dev/app.log ]]; then cat .dev/app.log; else docker logs normalize-allinone 2>&1; fi; }
link=$(src 2>/dev/null | grep 'DEV magic link' | tail -1 | sed 's/.*"url":"\([^"]*\)".*/\1/')
if [[ -z "$link" ]]; then echo "No magic link yet. Enter your email on http://localhost:3000/admin/login first." >&2; exit 1; fi
echo "$link"
