import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Two entry points share this project:
//
// - `index.html` (+ `src/client`) is the existing web dashboard, built into
//   `dist/client` and served by the Node server. It must keep working unchanged.
// - `src/desktop/index.html` (+ `src/desktop`) is the compact menubar panel of
//   the Tauri host, built into `dist/desktop-client` and loaded as
//   `frontendDist` by `src-tauri/tauri.conf.json`.
const mode = process.env.AGENTS_USAGE_VITE_ENTRY === 'desktop' ? 'desktop' : 'web';

// Rollup mirrors the source path of an HTML entry inside `outDir`
// (`src/desktop/index.html`), but the Tauri host serves the panel from the output
// root. Flatten the document to `index.html` so both the bundled assets and the
// dev URL (`/desktop/`) resolve to the same document, then drop the nested copy
// the HTML plugin has already written.
function flattenPanelDocument(outputDir: string, sourceDir: string): Plugin {
  const prefix = `${sourceDir}/`;
  return {
    name: 'agents-usage:flatten-panel-document',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !fileName.startsWith(prefix) || !fileName.endsWith('.html')) continue;
        delete bundle[fileName];
        output.fileName = fileName.slice(prefix.length);
        bundle[output.fileName] = output;
      }
    },
    writeBundle() {
      rmSync(resolve(__dirname, outputDir, sourceDir), { recursive: true, force: true });
    }
  };
}

const desktopOutDir = 'dist/desktop-client';

const desktop = {
  outDir: desktopOutDir,
  rollupOptions: {
    input: { desktop: resolve(__dirname, 'src/desktop/index.html') }
  }
};

const web = {
  outDir: 'dist/client',
  rollupOptions: {
    input: { index: resolve(__dirname, 'index.html') }
  }
};

export default defineConfig({
  plugins: [
    react(),
    ...(mode === 'desktop' ? [flattenPanelDocument(desktopOutDir, 'src/desktop')] : [])
  ],
  build: {
    ...(mode === 'desktop' ? desktop : web),
    // Both outputs live under `dist/`; each build clears only its own directory
    // through `npm run build:*`, so Vite must not empty the shared parent.
    emptyOutDir: false
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    // `target/` and `.dsh/` (repo-local CARGO_HOME) change while `tauri dev`
    // recompiles the host; watching them would full-reload the panel on every
    // Rust build instead of leaving HMR untouched. Globs must be `**/`-prefixed
    // to match the absolute paths chokidar watches.
    watch: {
      ignored: ['**/.dsh/**', '**/target/**', '**/dist/**']
    },
    proxy: {
      // The Rust service announces its own port through the discovery file; the
      // dev proxy targets the service default so the panel entry can be
      // exercised before the handshake exists (task 4.3).
      '/api': process.env.AGENTS_USAGE_SERVICE_ORIGIN ?? 'http://127.0.0.1:4716',
      '/events': process.env.AGENTS_USAGE_SERVICE_ORIGIN ?? 'http://127.0.0.1:4716'
    }
  }
});
