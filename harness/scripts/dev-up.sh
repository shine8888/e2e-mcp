#!/usr/bin/env bash
# The local Fintary stack, through the repo's own agent scripts (scripts/agent/*.sh in
# FINTARY_DIR) -- this file adds a status view and one machine-readable line, nothing else.
#
#   bash scripts/dev-up.sh --status   # what is listening: web :3001, api :3000, postgres :5431, auth emulator :4002
#   bash scripts/dev-up.sh --up       # scripts/agent/up.sh: Postgres + migrations/seed, auth emulator, API, web (emulator mode),
#                                     # and the seeded admin <seeded-admin-email> (uid <seeded-admin-uid>, the seeded account)
#   bash scripts/dev-up.sh --stop     # scripts/agent/down.sh (keeps the database volume)
#
# First time on a machine: bash "$FINTARY_DIR/scripts/agent/setup.sh" (deps, .env.local, images).
# Never touches :5432 -- that is the production AlloyDB proxy.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${FINTARY_DIR:-}" ]; then
  for d in "$HERE/../../fintary" "$HOME/Documents/WorkSpaces/FINTARY/fintary"; do
    [ -f "$d/pnpm-workspace.yaml" ] && [ -f "$d/services/web/package.json" ] && FINTARY_DIR="$(cd "$d" && pwd)" && break
  done
fi
FINTARY_DIR="${FINTARY_DIR:-$HERE/../../fintary}"
AGENT="$FINTARY_DIR/scripts/agent"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
http_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$1" 2>/dev/null)" = "200" ]; }

status() {
  local web=down api=down db=down auth=down
  http_ok http://localhost:3001/ && web=up
  http_ok http://localhost:3000/api/healthcheck && api=up
  docker exec local-psql pg_isready -U postgres -q >/dev/null 2>&1 && db=up
  listening 4002 && auth=up
  local prod=false; listening 5432 && prod=true
  printf 'web :3001 %s · api :3000 %s · postgres :5431 %s · auth emulator :4002 %s\n' "$web" "$api" "$db" "$auth"
  [ "$prod" = true ] && echo "WARNING: something listens on :5432 (the production database proxy). The stack never uses it; do not stop it, and never point the api at it."
  printf 'STATUS {"web":"%s","api":"%s","db":"%s","authEmulator":"%s","prodProxyListening":%s,"fintaryDir":"%s"}\n' "$web" "$api" "$db" "$auth" "$prod" "$FINTARY_DIR"
  [ "$web" = up ] && [ "$api" = up ]
}

case "${1:---status}" in
  --status) status ;;
  --up)
    [ -x "$AGENT/up.sh" ] || [ -f "$AGENT/up.sh" ] || { echo "No scripts/agent/up.sh under $FINTARY_DIR (set FINTARY_DIR)"; exit 2; }
    bash "$AGENT/up.sh"
    rc=$?
    status
    echo "Sign in on local as the seeded admin: harness/.env.local with E2E_EMULATOR=1, E2E_UID=<seeded-admin-uid>, E2E_EMAIL=<seeded-admin-email>"
    exit $rc ;;
  --stop|--down)
    [ -f "$AGENT/down.sh" ] || { echo "No scripts/agent/down.sh under $FINTARY_DIR"; exit 2; }
    bash "$AGENT/down.sh"
    status; exit 0 ;;
  *) echo "usage: $0 --status | --up | --stop"; exit 2 ;;
esac
