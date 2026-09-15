#!/usr/bin/env node
// Remove a build output directory, refusing to touch anything outside the repo.
//
// `vite build` writes the desktop panel into `dist/desktop-client`. Because that
// directory sits under the project's `dist/`, the build cannot rely on Vite's
// `emptyOutDir` (it only clears a directory that matches the output dir exactly
// and warns on anything else), so the build clears it through this script first.
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
