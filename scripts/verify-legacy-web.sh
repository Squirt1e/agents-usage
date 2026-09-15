#!/usr/bin/env bash
# Legacy web baseline verification.
#
# The desktop work must not break the existing Node dashboard: the startup and
# build commands, its data directory, its fallback paths and its tests all stay
# in place. This script is the single command that proves it, and it is what
# `npm run verify:legacy` runs. Add a flag to skip the slow production build:
#
#   bash scripts/verify-legacy-web.sh --no-build
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

run_build=1
for argument in "$@"; do
  case "$argument" in
    --no-build) run_build=0 ;;
    *) echo "unknown argument: $argument" >&2; exit 2 ;;
  esac
done

step() {
  local label="$1"
  shift
  printf '\n== %s ==\n' "$label"
  "$@"
}

step "typecheck" npm run --silent typecheck
step "lint" npm run --silent lint
step "legacy test suite" npm run --silent test

if [[ "$run_build" == "1" ]]; then
  step "production build" npm run --silent build
  for artifact in dist/server/index.js dist/client/index.html dist/desktop-client/index.html; do
    if [[ ! -f "$artifact" ]]; then
      echo "missing build artifact: $artifact" >&2
      exit 1
    fi
    printf 'artifact ok: %s\n' "$artifact"
  done
fi

printf '\nlegacy web baseline verified\n'
