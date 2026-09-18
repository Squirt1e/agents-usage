import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('macOS release asset naming', () => {
  it('renames the built dmg to the public versioned filename', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agents-usage-dmg-'));
    const source = join(directory, 'Agents Usage_1.2.1_universal.dmg');

    try {
      writeFileSync(source, 'dmg fixture');
      const result = spawnSync(
        process.execPath,
        ['scripts/desktop/prepare-release-dmg.mjs', source, '1.2.1'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );

      expect(result.status).toBe(0);
      const asset = result.stdout.trim();
      expect(basename(asset)).toBe('Agents-Usage_v1.2.1-macos.dmg');
      expect(readFileSync(asset, 'utf8')).toBe('dmg fixture');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
