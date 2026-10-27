#!/usr/bin/env bash
# Installs ft-e2e-mcp from wherever this folder was unzipped, and adds it to Claude Code.
#
#   bash install.sh [--fintary /path/to/fintary] [--scope user|local|project]
#                   [--skip-browsers] [--test] [--dry-run]
#
# What it does, in order:
#   1. finds node (nvm's Node 22 if present) and checks it is 18+
#   2. npm install for the MCP and the harness
#   3. downloads Playwright's Chromium, ffmpeg and WebKit (Safari's engine)
#   4. finds the fintary checkout (git stamps, the local stack, its sign-in scripts), unless --fintary is given
#   5. registers the MCP with Claude Code, using this folder and node's ABSOLUTE path
#   6. installs the /ft-e2e slash command (and /ft-e2e:<command>) into ~/.claude/commands
#   7. tells you what is left: the test user file per environment, and restarting Claude Code
# Nothing here asks for a password, writes a credential, or touches the fintary repo.
set -eo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FINTARY=""
SCOPE="user"
SKIP_BROWSERS=0
RUN_TEST=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fintary) FINTARY="$2"; shift ;;
    --scope) SCOPE="$2"; shift ;;
    --skip-browsers) SKIP_BROWSERS=1 ;;
    --test) RUN_TEST=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() { if [ $DRY = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

[ -f "$HERE/src/index.mjs" ] && [ -f "$HERE/harness/playwright.config.ts" ] || { echo "This does not look like the ft-e2e-mcp folder: $HERE" >&2; exit 1; }
say "ft-e2e-mcp folder: $HERE"

# 1. node
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +u; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true
fi
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found. Install Node 22 (nvm install 22) and run this again." >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "node $("$NODE_BIN" -v) is too old; need 18+ (22 recommended)." >&2; exit 1; }
say "node: $NODE_BIN ($("$NODE_BIN" -v))"
echo "  note: the fintary repo's own scripts (local stack, sign-in) use its .nvmrc Node; scripts/agent/up.sh switches to it."
NPM_BIN="$(dirname "$NODE_BIN")/npm"; [ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm)"
NPX_BIN="$(dirname "$NODE_BIN")/npx"; [ -x "$NPX_BIN" ] || NPX_BIN="$(command -v npx)"

# 2. dependencies
say "Installing dependencies"
run "$NPM_BIN" --prefix "$HERE" install --no-audit --no-fund
run "$NPM_BIN" --prefix "$HERE/harness" install --no-audit --no-fund

# 3. browsers
if [ $SKIP_BROWSERS = 0 ]; then
  say "Downloading Playwright browsers (Chromium, ffmpeg, WebKit)"
  (cd "$HERE/harness" && run "$NPX_BIN" playwright install chromium ffmpeg webkit)
fi

# 4. the fintary checkout
isfin() { [ -f "$1/pnpm-workspace.yaml" ] && [ -f "$1/services/web/package.json" ] && [ -d "$1/services/api" ]; }
if [ -z "$FINTARY" ]; then
  top="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$top" ] && isfin "$top"; then FINTARY="$top"; fi
fi
if [ -z "$FINTARY" ]; then
  # Every fintary checkout (Spotlight first, then a pruned find of $HOME); a folder named exactly fintary wins over worktrees.
  found="$(mdfind -name pnpm-workspace.yaml 2>/dev/null | grep '/fintary[^/]*/pnpm-workspace.yaml$' | while read -r f; do d="$(dirname "$f")"; isfin "$d" && echo "$d"; done || true)"
  [ -n "$found" ] || found="$(find "$HOME" -maxdepth 6 \( -name node_modules -o -name Library -o -name .Trash -o -name .git \) -prune -o \
    -type f -name pnpm-workspace.yaml -path '*fintary*' -print 2>/dev/null | while read -r f; do d="$(dirname "$f")"; isfin "$d" && echo "$d"; done || true)"
  FINTARY="$(printf '%s\n' "$found" | grep -E '/fintary$' | head -1 || true)"
  [ -n "$FINTARY" ] || FINTARY="$(printf '%s\n' "$found" | head -1)"
  [ "$(printf '%s\n' "$found" | grep -c . || true)" -gt 1 ] && echo "  several checkouts found; using $FINTARY (pass --fintary to choose another)"
fi
if [ -n "$FINTARY" ] && ! isfin "$FINTARY"; then
  echo "Not a fintary checkout (needs pnpm-workspace.yaml, services/web, services/api): $FINTARY" >&2; exit 1
fi
if [ -n "$FINTARY" ]; then FINTARY="$(cd "$FINTARY" && pwd)"; say "fintary: $FINTARY"
else echo "  fintary checkout not found. dev and uat runs still work; for the local stack re-run with --fintary /path/to/fintary."; fi

# 5. register in Claude Code
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "  Claude Code CLI not found. Register by hand later:"
  echo "  claude mcp add ft-e2e -s $SCOPE ${FINTARY:+-e FINTARY_DIR=$FINTARY }-- $NODE_BIN $HERE/src/index.mjs"
else
  say "Registering the MCP in Claude Code (scope: $SCOPE)"
  run "$CLAUDE_BIN" mcp remove ft-e2e -s "$SCOPE" >/dev/null 2>&1 || true
  if [ -n "$FINTARY" ]; then
    run "$CLAUDE_BIN" mcp add ft-e2e -s "$SCOPE" -e "FINTARY_DIR=$FINTARY" -- "$NODE_BIN" "$HERE/src/index.mjs"
  else
    run "$CLAUDE_BIN" mcp add ft-e2e -s "$SCOPE" -- "$NODE_BIN" "$HERE/src/index.mjs"
  fi
fi

# 6. the /ft-e2e command
say "Installing the /ft-e2e command"
run mkdir -p "$HOME/.claude/commands"
run cp "$HERE/claude/commands/ft-e2e.md" "$HOME/.claude/commands/ft-e2e.md"
run rm -rf "$HOME/.claude/commands/ft-e2e"
run cp -R "$HERE/claude/commands/ft-e2e" "$HOME/.claude/commands/ft-e2e"   # /ft-e2e:<command>, one per step
# the commands that write specs need this folder's path
[ $DRY = 1 ] || sed -i '' "s#__FT_E2E_HOME__#$HERE#g" "$HOME/.claude/commands/ft-e2e/"*.md

# optional self-test
if [ $RUN_TEST = 1 ]; then say "Self-test"; (cd "$HERE" && run "$NODE_BIN" test/smoke.mjs); fi

# 7. what is left
say "Done. Left for you:"
if [ -f "$HERE/harness/.env.dev" ]; then echo "  - dev test user: harness/.env.dev already exists"
else echo "  - signed-in specs on dev: cp \"$HERE/harness/.env.example\" \"$HERE/harness/.env.dev\" and fill in E2E_EMAIL / E2E_PASSWORD of a dev test user (never copy the app repo's production env files)"; fi
echo "  - uat: the same in harness/.env.uat · local: harness/.env.local (see .env.example for the stack's seeded admin)"
echo "  - posting to Linear: security add-generic-password -s ft-e2e-linear -a <your email> -w   (a personal API key)"
echo "  - restart Claude Code, then run /mcp (ft-e2e should be connected) and /ft-e2e doctor"
