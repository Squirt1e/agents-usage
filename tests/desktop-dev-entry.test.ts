import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { build: { devUrl: string } };
const DEV_URL = tauriConfig.build.devUrl;
let server: ChildProcess | undefined;

async function readWhenReady(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(DEV_URL);
      if (response.ok) return await response.text();
      lastError = new Error(`desktop dev entry returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}

afterEach(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // The process may already have stopped after a startup error.
    }
  }
  server = undefined;
});

describe('desktop development entry', () => {
  it('serves the compact panel document at the URL loaded by Tauri', async () => {
    server = spawn('npm', ['run', 'dev:desktop-web'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore'
    });

    const html = await readWhenReady();

    expect(html).toContain('id="panel-root"');
    expect(html).not.toContain('id="root"');
  }, 10_000);
});
