import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export interface RpcTransport {
  send(message: RpcMessage): void;
  onMessage(handler: (message: RpcMessage) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notifications = new Map<string, Set<(params: unknown) => void>>();

  constructor(private readonly transport: RpcTransport) {
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose((error) => {
      const reason = error ?? new Error('Codex app-server closed');
      for (const pending of this.pending.values()) pending.reject(reason);
      this.pending.clear();
    });
  }

  async initialize(clientInfo: { name: string; version: string }): Promise<unknown> {
    const result = await this.request('initialize', { clientInfo, capabilities: null });
    this.transport.send({ method: 'initialized' });
    return result;
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.transport.send({ id, method, params });
    return response;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notifications.get(method) ?? new Set();
    handlers.add(handler);
    this.notifications.set(method, handlers);
  }

  close() {
    this.transport.close();
  }

  private handleMessage(message: RpcMessage) {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.notifications.get(message.method) ?? []) handler(message.params);
    }
  }
}

export class StdioRpcTransport implements RpcTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly messageHandlers = new Set<(message: RpcMessage) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private buffer = '';
  private stderr = '';

  constructor(command = 'codex', args = ['app-server', '--stdio']) {
    this.process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8').on('data', (chunk: string) => this.consume(chunk));
    this.process.stderr.setEncoding('utf8').on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-2_000); });
    this.process.on('error', (error) => this.notifyClose(error));
    this.process.on('close', (code) => this.notifyClose(new Error(`Codex app-server exited (${code}): ${this.stderr.trim()}`)));
  }

  send(message: RpcMessage): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: RpcMessage) => void): void { this.messageHandlers.add(handler); }
  onClose(handler: (error?: Error) => void): void { this.closeHandlers.add(handler); }
  close(): void { this.process.kill('SIGTERM'); }

  private consume(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as RpcMessage;
        for (const handler of this.messageHandlers) handler(message);
      } catch {
        this.notifyClose(new Error('Codex app-server emitted invalid JSON'));
      }
    }
  }

  private notifyClose(error?: Error) {
    for (const handler of this.closeHandlers) handler(error);
  }
}

export class CodexAppServerSupervisor {
  private client?: JsonRpcClient;
  private failures = 0;
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

  constructor(
    private readonly transportFactory: () => RpcTransport = () => new StdioRpcTransport(),
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly maximumBackoffMs = 30_000
  ) {}

  async connect(): Promise<JsonRpcClient> {
    if (this.client) return this.client;
    const client = new JsonRpcClient(this.transportFactory());
    try {
      await client.initialize({ name: 'agents-usage', version: '0.1.0' });
      for (const [method, handlers] of this.notificationHandlers) {
        for (const handler of handlers) client.onNotification(method, handler);
      }
      this.client = client;
      this.failures = 0;
      return client;
    } catch (error) {
      client.close();
      this.failures += 1;
      await this.wait(Math.min(250 * 2 ** (this.failures - 1), this.maximumBackoffMs));
      throw error;
    }
  }

  invalidate() {
    this.client?.close();
    this.client = undefined;
  }

  async request(method: string, params: unknown = {}): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const client = await this.connect();
        return await client.request(method, params);
      } catch (error) {
        lastError = error;
        this.invalidate();
        if (attempt === 0) {
          this.failures += 1;
          await this.wait(Math.min(250 * 2 ** (this.failures - 1), this.maximumBackoffMs));
        }
      }
    }
    throw lastError;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    this.client?.onNotification(method, handler);
  }
}
