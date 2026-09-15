#!/usr/bin/env node
// Run the Vite dev server for the desktop panel entry.
//
// The panel reads usage data from the Rust service over loopback. The port is
// announced by the service's discovery file, not assumed; the dev server also
// exposes a `/api` and `/events` proxy so the panel can be exercised in a plain
// browser before that handshake exists. The Tauri host loads
// `http://127.0.0.1:5174/src/desktop/` (see `devUrl` in `src-tauri/tauri.conf.json`).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const viteBin = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const port = 5174;

// Several dev sessions can run on this machine at once (e.g. two agent
// sessions). `--strictPort` would make the second `tauri dev` abort on the
// busy port, so when a server is already listening, idle instead and let it
// use the existing server; the single-instance plugin merges the app windows.
function reuseExistingServer() {
  console.log(`[dev-web] port ${port} already serving — reusing it; this helper idles until tauri dev exits.`);
  // A ref'd timer keeps the process alive until tauri dev reclaims it.
  setInterval(() => {}, 1 << 30);
}

function startVite() {
  const child = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'inherit'
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

const probe = net.connect({ host: '127.0.0.1', port });
probe.once('connect', () => {
  probe.destroy();
  reuseExistingServer();
});
probe.once('error', () => {
  probe.destroy();
  startVite();
});
