#!/usr/bin/env node
// Remove a build output directory, refusing to touch anything outside the repo.
//
// `vite build` writes separate output directories for the legacy web entry
// (`dist/client`) and the desktop panel entry (`dist/desktop-client`). Because
// both live under `dist/`, the two builds cannot rely on Vite's `emptyOutDir`
// (it only clears a directory that matches the output dir exactly and warns on
// anything else), so each build clears its own directory through this script.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const target = process.argv[2];

if (!target) {
  console.error('usage: clear-dir.mjs <path-relative-to-repo-root>');
  process.exit(2);
}

const absolute = resolve(repoRoot, target);
const rel = relative(repoRoot, absolute);
if (!rel || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
  console.error(`refusing to clear ${absolute}: outside the repository root`);
  process.exit(2);
}

rmSync(absolute, { recursive: true, force: true });
