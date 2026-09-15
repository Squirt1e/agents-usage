#!/usr/bin/env bash
# Cargo wrapper for this repository.
#
# Why: several tools in this project run with a file sandbox that only allows
# writes inside the repository. Cargo writes to `$CARGO_HOME` (downloads, the
# registry index, build locks), so `~/.cargo` is unusable in that situation.
# We point cargo at a repository-local cache instead, which is also handy for
# keeping a rust build fully self-contained. Override with
# `AGENTS_USAGE_CARGO_HOME` when a different cache is wanted.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo_home="${AGENTS_USAGE_CARGO_HOME:-$repo_root/.dsh/cargo-home}"
mkdir -p "$cargo_home"

export CARGO_HOME="$cargo_home"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/target}"

exec cargo "$@"
