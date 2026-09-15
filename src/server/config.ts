import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ProviderTiming {
  refreshMs: number;
  timeoutMs: number;
  cooldownMs: number;
  maxBackoffMs: number;
}

export interface RuntimeConfig {
  host: '127.0.0.1' | '::1';
  port: number;
  timezone: string;
  dataDir: string;
  observationRetentionDays: number;
  providers: Record<'codex' | 'glm' | 'deepseek', ProviderTiming>;
  experimental: {
    glmWallet: boolean;
  };
}

function integer(env: Record<string, string | undefined>, key: string, fallback: number, minimum = 1) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}`);
  return value;
}

function bool(raw: string | undefined, fallback: boolean) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('Boolean configuration values must be true or false');
}

function timezone(raw: string | undefined) {
  const value = raw || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid timezone: ${value}`);
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const host = env.AGENTS_USAGE_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Dashboard host must be a loopback address');

  const timing = (prefix: string, refreshMs: number): ProviderTiming => ({
    refreshMs: integer(env, `AGENTS_USAGE_${prefix}_REFRESH_MS`, refreshMs, 30_000),
    timeoutMs: integer(env, `AGENTS_USAGE_${prefix}_TIMEOUT_MS`, 15_000, 1_000),
    cooldownMs: integer(env, `AGENTS_USAGE_${prefix}_COOLDOWN_MS`, 30_000, 1_000),
    maxBackoffMs: integer(env, `AGENTS_USAGE_${prefix}_MAX_BACKOFF_MS`, 900_000, 10_000)
  });

  return {
    host,
    port: integer(env, 'AGENTS_USAGE_PORT', 4715, 1),
    timezone: timezone(env.AGENTS_USAGE_TIMEZONE),
    dataDir: env.AGENTS_USAGE_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'agents-usage'),
    observationRetentionDays: integer(env, 'AGENTS_USAGE_OBSERVATION_RETENTION_DAYS', 30),
    providers: {
      codex: timing('CODEX', 300_000),
      glm: timing('GLM', 300_000),
      deepseek: timing('DEEPSEEK', 300_000)
    },
    experimental: {
      glmWallet: bool(env.AGENTS_USAGE_EXPERIMENTAL_GLM_WALLET, false)
    }
  };
}
