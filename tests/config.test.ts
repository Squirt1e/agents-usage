import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';

describe('runtime configuration', () => {
  it('uses conservative loopback-only defaults', () => {
    const config = loadConfig({});

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4715);
    expect(config.timezone).toBeTruthy();
    expect(config.providers.glm.refreshMs).toBeGreaterThanOrEqual(120_000);
    expect(config.providers.deepseek.refreshMs).toBeGreaterThanOrEqual(120_000);
    expect(config.observationRetentionDays).toBe(30);
    expect(config.experimental.glmWallet).toBe(false);
  });

  it('rejects unsafe non-loopback hosts', () => {
    expect(() => loadConfig({ AGENTS_USAGE_HOST: '0.0.0.0' })).toThrow(/loopback/i);
  });

  it('accepts explicit safe timing overrides', () => {
    const config = loadConfig({
      AGENTS_USAGE_PORT: '6001',
      AGENTS_USAGE_TIMEZONE: 'Asia/Shanghai',
      AGENTS_USAGE_GLM_REFRESH_MS: '300000',
      AGENTS_USAGE_OBSERVATION_RETENTION_DAYS: '45',
      AGENTS_USAGE_EXPERIMENTAL_GLM_WALLET: 'true'
    });

    expect(config.port).toBe(6001);
    expect(config.timezone).toBe('Asia/Shanghai');
    expect(config.providers.glm.refreshMs).toBe(300_000);
    expect(config.observationRetentionDays).toBe(45);
    expect(config.experimental.glmWallet).toBe(true);
  });
});
