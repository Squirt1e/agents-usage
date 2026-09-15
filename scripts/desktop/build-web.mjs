#!/usr/bin/env node
// Build the desktop panel web assets for the Tauri host.
//
// The panel is a second Vite entry point of the existing project
// (`src/desktop/index.html`), emitted to `dist/desktop-client`, which is the
// `frontendDist` used by `src-tauri/tauri.conf.json`. The legacy web entry
// (`dist/client`) is built separately by `npm run build:client`; both are part of
// `npm run build`, so one command still keeps both entry points working.
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
  stdio: 'inherit',
  env: {
    ...process.env,
    // Selects the panel entry point of `vite.config.ts` (`dist/desktop-client`).
    AGENTS_USAGE_VITE_ENTRY: 'desktop'
  }
});

process.exit(result.status ?? 1);
