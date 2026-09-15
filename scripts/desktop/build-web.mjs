#!/usr/bin/env node
// Build the desktop front ends for the Tauri host.
//
// Two documents, one output directory: `src/desktop/index.html` (the menubar
// panel) and `src/desktop/settings.html` (the settings window), both emitted to
// `dist/desktop-client`, which is the `frontendDist` used by
// `src-tauri/tauri.conf.json`. Vite flattens both to the output root; the host
// loads them as `index.html` and `settings.html`.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const viteBin = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const outDir = join(repoRoot, 'dist', 'desktop-client');

// Clear the output first. Vite cannot do it itself here (`emptyOutDir` only
// clears a directory that matches the project root's own `dist`), and *every*
// earlier build's hashed asset file would otherwise stay behind. That matters
// because Tauri embeds the whole `frontendDist` directory into the host binary:
// leftovers from previous builds were being shipped inside the app, ten
// megabytes of assets nothing references. `npm run build:desktop-web` clears the
// same directory as well; removing it twice is a no-op, and doing it here is what
// makes the Tauri `beforeBuildCommand` path clean too.
rmSync(outDir, { recursive: true, force: true });

const result = spawnSync(process.execPath, [viteBin, 'build'], {
  cwd: repoRoot,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
