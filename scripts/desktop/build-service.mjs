#!/usr/bin/env node
// Build the usage-service sidecar and stage it for the Tauri bundler.
//
// The host launches the service as a bundled helper program, so the packaged
// app runs without Node. Tauri does not build workspace sibling binaries by
// itself, so this script (wired as `beforeBuildCommand`) compiles the service in
// release mode and copies it to the path `externalBin` bundles:
// `src-tauri/binaries/usage-service-<target-triple>`.
//
// A universal build needs a universal sidecar, and Tauri resolves that one by the
// target it was asked for — `universal-apple-darwin`, which is not a rustc target
// at all. So the requested target decides what is built here: one slice for a
// normal build, both slices plus a `lipo` merge for a universal one. Staging the
// per-slice copies as well is deliberate: it costs nothing and covers the bundler
// merging two single-arch bundles instead of one universal one.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stageDir = join(repoRoot, 'src-tauri', 'binaries');
mkdirSync(stageDir, { recursive: true });

const UNIVERSAL = 'universal-apple-darwin';
const UNIVERSAL_SLICES = ['x86_64-apple-darwin', 'aarch64-apple-darwin'];

/** The target Tauri asked for; its hooks receive it as an environment variable. */
function requestedTarget() {
  const fromTauri = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (fromTauri) return fromTauri;
  const described = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' });
  return described.stdout?.trim() || 'x86_64-apple-darwin';
}

const requested = requestedTarget();
const slices = requested === UNIVERSAL ? UNIVERSAL_SLICES : [requested];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const slice of slices) {
  // `--target` beats the workspace's `[build] target` in `.cargo/config.toml`, which
  // pins the machine's own architecture.
  run('bash', ['tools/cargo.sh', 'build', '--release', '-p', 'usage-service', '--target', slice]);
  const binary = join(repoRoot, 'target', slice, 'release', 'usage-service');
  if (!existsSync(binary)) {
    console.error(`usage-service was not built for ${slice}`);
    process.exit(1);
  }
  cpSync(binary, join(stageDir, `usage-service-${slice}`));
}

if (requested === UNIVERSAL) {
  const staged = join(stageDir, `usage-service-${UNIVERSAL}`);
  run('lipo', [
    '-create',
    ...slices.map((slice) => join(stageDir, `usage-service-${slice}`)),
    '-output',
    staged
  ]);
  console.log(`staged universal sidecar -> ${staged}`);
} else {
  console.log(`staged sidecar for ${requested}`);
}
