import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { build: { devUrl: string } };
const DEV_URL = tauriConfig.build.devUrl;

/**
 * The development URL of the settings window.
 *
 * `settings_window_url()` in `src-tauri/src/lib.rs` builds this from the panel's
 * `devUrl` plus the file name, and both documents are served by the same Vite server
 * in dev — so the sibling of `DEV_URL` is the honest place to look. Kept in step with
 * that function by `settings_dev_url_matches_the_vite_server` in lib.rs.
 */
const DEV_SETTINGS_URL = new URL('settings.html', DEV_URL).toString();

let server: ChildProcess | undefined;

/**
 * One server for the whole file, not one per test.
 *
 * `scripts/desktop/dev-web.mjs` *reuses* a server that is already listening on the
 * port (several dev sessions can run at once on one machine), which means a second
 * spawn while the first is still shutting down idles instead of serving — and the
 * fetch then fails with nothing to explain it. Starting it once removes that race.
 */
beforeAll(async () => {
  server = spawn('npm', ['run', 'dev:desktop-web'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore'
  });
  await fetchWhenReady(DEV_URL);
}, 20_000);

afterAll(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // The process may already have stopped after a startup error.
    }
  }
  server = undefined;
});

async function fetchWhenReady(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      lastError = new Error(`desktop dev entry returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}

describe('desktop development entry', () => {
  it('serves the compact panel document at the URL loaded by Tauri', async () => {
    const html = await fetchWhenReady(DEV_URL);

    expect(html).toContain('id="panel-root"');
    expect(html).not.toContain('id="root"');
  }, 10_000);

  it('serves the settings window document at the URL its builder produces', async () => {
    // The host opens two documents now, and only one of them was covered here. This is
    // the side a test *can* hold: the URL the Rust builder points at really serves the
    // settings document, and that document really names its own entry module. A typo in
    // either one is a blank window at runtime, which is exactly what a check like this
    // should catch.
    const html = await fetchWhenReady(DEV_SETTINGS_URL);

    expect(html).toContain('id="settings-root"');
    expect(html).not.toContain('id="panel-root"');
    // The module the document asks for has to exist: the panel's entry was renamed to
    // `.tsx` when it grew JSX, and the settings entry was born that way.
    const script = /src="\.\/([\w.-]+)"/.exec(html)?.[1];
    expect(script, 'settings.html must name its entry module').toBe('settings-main.tsx');
    expect(existsSync(new URL(`../src/desktop/${script}`, import.meta.url)), `${script} is missing`).toBe(true);
  }, 10_000);

  it('serves the panel document from a module that exists too', async () => {
    // The same check for the other document, so a rename on either side is caught:
    // `main.ts` became `main.tsx` in this change, and a stale `src` attribute would
    // have produced an empty panel window with no error anywhere obvious.
    const html = await fetchWhenReady(DEV_URL);
    const script = /src="\.\/([\w.-]+)"/.exec(html)?.[1];
    expect(script, 'index.html must name its entry module').toBe('main.tsx');
    expect(existsSync(new URL(`../src/desktop/${script}`, import.meta.url)), `${script} is missing`).toBe(true);
  }, 10_000);
});
