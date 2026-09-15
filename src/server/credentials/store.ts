import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { ProviderId } from '../../shared/contracts';

export interface CredentialStore {
  get(provider: ProviderId, account: string): Promise<string | undefined>;
  set(provider: ProviderId, account: string, secret: string): Promise<void>;
  delete(provider: ProviderId, account: string): Promise<void>;
}

export type CredentialValidator = (provider: ProviderId, secret: string, account: string) => Promise<{ valid: boolean; message?: string }>;
export type CommandRunner = (command: string, args: string[], input?: string) => Promise<{ stdout: string; stderr: string }>;
export type SpawnCommand = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export function createCommandRunner(spawnCommand: SpawnCommand = spawn as SpawnCommand): CommandRunner {
  return (command, args, input) => new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Credential store command failed (${code}): ${stderr.trim()}`));
    });
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  });
}

const runCommand = createCommandRunner();

export class MacOSKeychainStore implements CredentialStore {
  constructor(private readonly runner: CommandRunner = runCommand) {}

  private service(provider: ProviderId) {
    return `agents-usage.${provider}`;
  }

  async get(provider: ProviderId, account: string): Promise<string | undefined> {
    try {
      const result = await this.runner('security', [
        'find-generic-password', '-a', account, '-s', this.service(provider), '-w'
      ]);
      return result.stdout.trim() || undefined;
    } catch (error) {
      if (error instanceof Error && /could not be found|failed \(44\)/i.test(error.message)) return undefined;
      throw error;
    }
  }

  async set(provider: ProviderId, account: string, secret: string): Promise<void> {
    // The account and service come first and `-w` last: with the options in that
    // order (the order `security`'s own usage prints) it prompts for the password
    // and reads it from stdin, so the secret never reaches the argument list.
    await this.runner('security', [
      'add-generic-password', '-U', '-a', account, '-s', this.service(provider), '-w'
    ], `${secret}\n${secret}`);
  }

  async delete(provider: ProviderId, account: string): Promise<void> {
    try {
      await this.runner('security', ['delete-generic-password', '-a', account, '-s', this.service(provider)]);
    } catch (error) {
      if (error instanceof Error && /could not be found|failed \(44\)/i.test(error.message)) return;
      throw error;
    }
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  private key(provider: ProviderId, account: string) { return `${provider}:${account}`; }
  async get(provider: ProviderId, account: string): Promise<string | undefined> { return this.values.get(this.key(provider, account)); }
  async set(provider: ProviderId, account: string, secret: string): Promise<void> { this.values.set(this.key(provider, account), secret); }
  async delete(provider: ProviderId, account: string): Promise<void> { this.values.delete(this.key(provider, account)); }
}

export class CredentialManager {
  constructor(private readonly store: CredentialStore, private readonly validator: CredentialValidator) {}

  async replace(provider: ProviderId, account: string, secret: string, validate = true): Promise<void> {
    const trimmed = secret.trim();
    if (!trimmed) throw new Error('Credential cannot be empty');
    if (validate) {
      const result = await this.validator(provider, trimmed, account);
      if (!result.valid) throw new Error(result.message || 'Credential validation failed');
    }
    await this.store.set(provider, account, trimmed);
  }

  async status(provider: ProviderId, account: string): Promise<{ configured: boolean; suffix?: string }> {
    const secret = await this.store.get(provider, account);
    return secret ? { configured: true, suffix: secret.slice(-4) } : { configured: false };
  }

  async resolve(provider: ProviderId, account: string): Promise<string | undefined> {
    return this.store.get(provider, account);
  }

  async delete(provider: ProviderId, account: string): Promise<void> {
    await this.store.delete(provider, account);
  }
}
