#!/usr/bin/env bash
# Wrapper around the Tauri CLI for this repository.
#
# The host lives in `src-tauri/`, but the repository root is also the Rust
# workspace root and the Vite project root. Running the CLI from the root and
# pointing it at the config keeps `cargo` (workspace root) and the panel front
# end (repository root) consistent, and it routes the build through
# `tools/cargo.sh` so cargo uses a writable CARGO_HOME.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri_bin="$repo_root/node_modules/.bin/tauri"

if [[ ! -x "$tauri_bin" ]]; then
  echo "The Tauri CLI is missing. Run: npm install" >&2
  exit 1
fi

export CARGO_HOME="${AGENTS_USAGE_CARGO_HOME:-$repo_root/.dsh/cargo-home}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/target}"
mkdir -p "$CARGO_HOME"

cd "$repo_root"

# The base config goes before the caller's args: Tauri merges repeated --config
# values left to right, so an extra --config from the caller (e.g. the dev
# identifier override) must land after it to win.
subcommand="${1:-}"
if [[ -z "$subcommand" || "$subcommand" == -* ]]; then
  exec "$tauri_bin" "$@" --config src-tauri/tauri.conf.json
fi
shift
exec "$tauri_bin" "$subcommand" --config src-tauri/tauri.conf.json "$@"
