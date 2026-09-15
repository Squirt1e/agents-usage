import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Two entry points, both under `src/desktop` and both built into
// `dist/desktop-client`, which is the `frontendDist` used by
// `src-tauri/tauri.conf.json`:
//
//   - `index.html`    → the compact menubar panel (the "panel" window),
//   - `settings.html` → the settings window (the "settings" window).
//
// They are separate documents because they are separate host windows with
// different chrome: the panel is borderless, transparent and sized to its content,
// while the settings window is a fixed 560x380 window with a system title bar.
// They share `panel.css` and every component underneath it — see settings.css.

// Rollup mirrors the source path of an HTML entry inside `outDir`
// (`src/desktop/index.html`), but the Tauri host serves both documents from the
// output root. Flatten them to the root so the bundled assets and the dev URLs
// (`/desktop/` and `/desktop/settings.html`) resolve to the same documents, then
// drop the nested copies the HTML plugin has already written.
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

export default defineConfig({
  plugins: [react(), flattenPanelDocument(desktopOutDir, 'src/desktop')],
  build: {
    outDir: desktopOutDir,
    rollupOptions: {
      input: {
        desktop: resolve(__dirname, 'src/desktop/index.html'),
        settings: resolve(__dirname, 'src/desktop/settings.html')
      }
    },
    // The output directory is cleared by `scripts/clear-dir.mjs` before the build.
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
