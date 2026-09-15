#!/usr/bin/env node
// Build the usage-service sidecar and stage it for the Tauri bundler.
//
// The host launches the service as a bundled helper program, so the packaged
// app runs without Node. Tauri does not build workspace sibling binaries by
// itself, so this script (wired as `beforeBundleCommand`) compiles the service
// in release mode and copies it to a stable path that `externalBin` bundles.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stageDir = join(repoRoot, 'src-tauri', 'binaries');
mkdirSync(stageDir, { recursive: true });

const build = spawnSync('bash', ['tools/cargo.sh', 'build', '--release', '-p', 'usage-service'], {
  cwd: repoRoot,
  stdio: 'inherit'
});
if (build.status !== 0) process.exit(build.status ?? 1);

// The release binary lives under target/<triple>/release/usage-service, and
// Tauri's `externalBin` expects the staged file to carry the target triple
// suffix (`usage-service-<triple>`).
const targetRoot = join(repoRoot, 'target');
let binary;
let triple = '';
if (existsSync(targetRoot)) {
  for (const entry of readdirSync(targetRoot)) {
    const candidate = join(targetRoot, entry, 'release', 'usage-service');
    if (existsSync(candidate)) {
      binary = candidate;
      triple = entry;
      break;
    }
  }
}
if (!binary) {
  console.error('usage-service release binary was not found under target/');
  process.exit(1);
}

const staged = join(stageDir, `usage-service-${triple}`);
cpSync(binary, staged);
console.log(`staged ${binary} -> ${staged}`);
