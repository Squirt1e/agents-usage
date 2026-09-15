import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from './api';
import { CodexAdapter } from './adapters/codex/adapter';
import { CodexAppServerSupervisor } from './adapters/codex/json-rpc';
import { DeepSeekAdapter } from './adapters/deepseek';
import { DailySpendEstimator } from './adapters/deepseek-estimator';
import { GlmAdapter, GlmWalletAdapter, type GlmRegion } from './adapters/glm';
import type { ProviderAdapter } from './adapters/types';
import { loadConfig } from './config';
import { CredentialManager, MacOSKeychainStore } from './credentials/store';
import { createSafeLogger } from './logging';
import { UsageOrchestrator } from './orchestrator';
import { UsageDatabase } from './persistence/database';

export interface RuntimeOptions {
  adapters?: ProviderAdapter[];
  credentials?: CredentialManager;
  clientDir?: string;
  collectorVersions?: Record<string, string>;
}

function installedCodexVersion() {
  try { return execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim(); }
  catch { return 'unavailable'; }
}

export function createRuntime(env: Record<string, string | undefined> = process.env, options: RuntimeOptions = {}) {
  const config = loadConfig(env);
  const database = new UsageDatabase(join(config.dataDir, 'usage.sqlite3'));
  database.compactObservations(new Date(Date.now() - config.observationRetentionDays * 86_400_000).toISOString());
  const keychain = new MacOSKeychainStore();
  const credentials = options.credentials ?? new CredentialManager(keychain, async (provider, secret, account) => {
    try {
      if (provider === 'glm') {
        if (account === 'wallet-experimental') {
          await new GlmWalletAdapter({
            enabled: true,
            endpoint: env.AGENTS_USAGE_GLM_WALLET_ENDPOINT ?? '',
            getCredential: async () => secret
          }).refresh();
          return { valid: true };
        }
        const adapter = new GlmAdapter({
          region: database.getSetting<GlmRegion>('glm.region') ?? 'china',
          getCredential: async () => secret
        });
        await adapter.refresh();
        return { valid: true };
      }
      if (provider === 'deepseek') {
        await new DeepSeekAdapter({ getCredential: async () => secret }).refresh();
        return { valid: true };
      }
      return { valid: false, message: 'This provider does not accept a dashboard credential' };
    } catch (error) {
      return { valid: false, message: error instanceof Error ? error.message : 'Credential validation failed' };
    }
  });

  let supervisor: CodexAppServerSupervisor | undefined;
  let adapters = options.adapters;
  if (!adapters) {
    supervisor = new CodexAppServerSupervisor();
    const codex = new CodexAdapter(supervisor);
    const glm = new GlmAdapter({
      region: () => database.getSetting<GlmRegion>('glm.region') ?? 'china',
      getCredential: () => credentials.resolve('glm', 'default')
    });
    const deepseek = new DeepSeekAdapter({
      getCredential: () => credentials.resolve('deepseek', 'default'),
      estimator: new DailySpendEstimator(database, config.timezone)
    });
    const glmWallet = new GlmWalletAdapter({
      enabled: () => database.getSetting<boolean>('glm.wallet.enabled') ?? config.experimental.glmWallet,
      endpoint: env.AGENTS_USAGE_GLM_WALLET_ENDPOINT ?? '',
      getCredential: () => credentials.resolve('glm', 'wallet-experimental')
    });
    adapters = [codex, glm, glmWallet, deepseek];
  }

  const orchestrator = new UsageOrchestrator(adapters, database, config.providers);
  const codexAdapter = adapters.find((adapter): adapter is CodexAdapter => adapter instanceof CodexAdapter);
  codexAdapter?.onRateLimitsUpdated(() => { void orchestrator.refreshProvider('codex', { force: true }); });
  const builtClientDir = resolve(dirname(fileURLToPath(import.meta.url)), '../client');
  const server = createDashboardServer({
    orchestrator,
    database,
    credentials,
    config,
    clientDir: options.clientDir ?? builtClientDir,
    collectorVersions: options.collectorVersions ?? {
      dashboard: '1.0.0', codex: installedCodexVersion(), glm: 'monitor-v1', deepseek: 'balance-v1'
    }
  });
  let listening = false;

  return {
    config, database, credentials, orchestrator,
    async start(startOptions: { port?: number; schedule?: boolean } = {}) {
      const address = await server.listen(startOptions.port);
      listening = true;
      if (startOptions.schedule !== false) orchestrator.start();
      return address;
    },
    async stop() {
      orchestrator.stop();
      supervisor?.invalidate();
      if (listening) {
        await server.close();
        listening = false;
      }
      database.close();
    }
  };
}

export const runtimeConfig = loadConfig();

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const logger = createSafeLogger((line) => process.stdout.write(`${line}\n`));
  const runtime = createRuntime();
  runtime.start().then((address) => {
    logger.info('Dashboard listening', { url: address.url, database: runtime.database.getDiagnostics() });
  }).catch((error) => {
    logger.error('Dashboard failed to start', error);
    process.exitCode = 1;
  });
  const shutdown = () => { void runtime.stop().finally(() => { process.exitCode = 0; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
