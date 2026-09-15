import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { RuntimeConfig } from './config';
import type { CredentialManager } from './credentials/store';
import type { UsageOrchestrator } from './orchestrator';
import type { UsageDatabase } from './persistence/database';
import type { ProviderId } from '../shared/contracts';
import { redactSecrets } from '../shared/redaction';

export interface DashboardServer {
  listen(port?: number): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

export function createDashboardServer(_dependencies: {
  orchestrator: UsageOrchestrator;
  database: UsageDatabase;
  credentials: CredentialManager;
  config: RuntimeConfig;
  clientDir?: string;
  collectorVersions?: Record<string, string>;
}): DashboardServer {
  const dependencies = _dependencies;
  const sessionToken = randomBytes(32).toString('base64url');
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

  function secureHeaders(response: ServerResponse) {
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
  }

  function sendJson(response: ServerResponse, status: number, value: unknown, shouldRedact = true) {
    secureHeaders(response);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(shouldRedact ? redactSecrets(value) : value));
  }

  function sendError(response: ServerResponse, status: number, message: string) {
    sendJson(response, status, { error: message });
  }

  function isLoopbackAddress(address: string | undefined) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  function hostIsTrusted(host: string | undefined) {
    if (!host) return false;
    try {
      const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
      return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
    } catch {
      return false;
    }
  }

  function originIsTrusted(request: IncomingMessage) {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const url = new URL(origin);
      const originHost = url.hostname.replace(/^\[|\]$/g, '');
      return url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(originHost) && url.host === request.headers.host;
    } catch {
      return false;
    }
  }

  function mutationAllowed(request: IncomingMessage) {
    return request.headers['x-session-token'] === sessionToken;
  }

  async function readBody(request: IncomingMessage, limit = 16_384) {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    }
    if (!body) return {};
    try { return JSON.parse(body) as Record<string, unknown>; }
    catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
  }

  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'
  };

  function serveStatic(pathname: string, response: ServerResponse) {
    if (!dependencies.clientDir) return false;
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
    let file = join(dependencies.clientDir, safe);
    if (!existsSync(file) || !statSync(file).isFile()) file = join(dependencies.clientDir, 'index.html');
    if (!existsSync(file)) return false;
    secureHeaders(response);
    response.statusCode = 200;
    response.setHeader('Content-Type', mimeTypes[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(response);
    return true;
  }

  async function settings() {
    const [glm, deepseek, glmWallet] = await Promise.all([
      dependencies.credentials.status('glm', 'default'),
      dependencies.credentials.status('deepseek', 'default'),
      dependencies.credentials.status('glm', 'wallet-experimental')
    ]);
    return {
      glmRegion: dependencies.database.getSetting<'china' | 'international'>('glm.region') ?? 'china',
      timezone: dependencies.config.timezone,
      experimental: {
        glmWallet: dependencies.database.getSetting<boolean>('glm.wallet.enabled') ?? dependencies.config.experimental.glmWallet
      },
      credentials: { glm, deepseek, glmWallet, codex: { delegated: true } }
    };
  }

  const httpServer = createServer(async (request, response) => {
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress) || !hostIsTrusted(request.headers.host)) {
        sendError(response, 403, 'Loopback access only');
        return;
      }
      if (!originIsTrusted(request)) {
        sendError(response, 403, 'Untrusted origin');
        return;
      }
      const method = request.method ?? 'GET';
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !mutationAllowed(request)) {
        sendError(response, 403, 'Invalid local session token');
        return;
      }

      if (method === 'GET' && pathname === '/api/bootstrap') {
        sendJson(response, 200, { sessionToken, settings: await settings() }, false);
        return;
      }
      if (method === 'GET' && pathname === '/api/snapshots') {
        sendJson(response, 200, { providers: dependencies.orchestrator.getAllStates() });
        return;
      }
      if (method === 'GET' && pathname === '/api/settings') {
        sendJson(response, 200, await settings());
        return;
      }
      if (method === 'GET' && pathname === '/api/diagnostics') {
        const [glm, deepseek, glmWallet] = await Promise.all([
          dependencies.credentials.status('glm', 'default'),
          dependencies.credentials.status('deepseek', 'default'),
          dependencies.credentials.status('glm', 'wallet-experimental')
        ]);
        sendJson(response, 200, {
          database: dependencies.database.getDiagnostics(),
          collectors: dependencies.collectorVersions ?? {},
          providers: dependencies.orchestrator.getDiagnostics(),
          credentials: { glm, deepseek, glmWallet, codex: { delegated: true } }
        });
        return;
      }
      if (method === 'PUT' && pathname === '/api/settings') {
        const body = await readBody(request);
        if (body.glmRegion !== undefined) {
          if (body.glmRegion !== 'china' && body.glmRegion !== 'international') throw Object.assign(new Error('Invalid GLM region'), { status: 400 });
          dependencies.database.setSetting('glm.region', body.glmRegion);
        }
        if (body.experimental !== undefined) {
          if (!body.experimental || typeof body.experimental !== 'object' || typeof (body.experimental as Record<string, unknown>).glmWallet !== 'boolean') {
            throw Object.assign(new Error('Invalid experimental settings'), { status: 400 });
          }
          const enabled = (body.experimental as { glmWallet: boolean }).glmWallet;
          dependencies.database.setSetting('glm.wallet.enabled', enabled);
          if (!enabled) await dependencies.credentials.delete('glm', 'wallet-experimental');
        }
        sendJson(response, 200, await settings());
        return;
      }
      const credentialMatch = pathname.match(/^\/api\/credentials\/(glm|deepseek|glm-wallet)$/);
      if (credentialMatch && method === 'PUT') {
        const target = credentialMatch[1] as 'glm' | 'deepseek' | 'glm-wallet';
        const provider = target === 'glm-wallet' ? 'glm' : target;
        const account = target === 'glm-wallet' ? 'wallet-experimental' : 'default';
        const body = await readBody(request);
        if (typeof body.secret !== 'string') throw Object.assign(new Error('Credential is required'), { status: 400 });
        await dependencies.credentials.replace(provider, account, body.secret, body.validate !== false);
        sendJson(response, 200, await dependencies.credentials.status(provider, account));
        return;
      }
      if (credentialMatch && method === 'DELETE') {
        const target = credentialMatch[1] as 'glm' | 'deepseek' | 'glm-wallet';
        const provider = target === 'glm-wallet' ? 'glm' : target;
        const account = target === 'glm-wallet' ? 'wallet-experimental' : 'default';
        await dependencies.credentials.delete(provider, account);
        response.statusCode = 204;
        secureHeaders(response);
        response.end();
        return;
      }
      const refreshMatch = pathname.match(/^\/api\/refresh\/(codex|glm|deepseek)$/);
      if (refreshMatch && method === 'POST') {
        const result = await dependencies.orchestrator.refreshProvider(refreshMatch[1] as ProviderId);
        sendJson(response, result.status === 'cooldown' ? 429 : result.status === 'success' ? 200 : 503, result);
        return;
      }
      if (method === 'GET' && pathname === '/events') {
        secureHeaders(response);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Connection', 'keep-alive');
        response.flushHeaders();
        response.write(`event: snapshot\ndata: ${JSON.stringify({ providers: dependencies.orchestrator.getAllStates() })}\n\n`);
        const unsubscribe = dependencies.orchestrator.subscribe((event) => {
          response.write(`event: provider\ndata: ${JSON.stringify(redactSecrets(event))}\n\n`);
        });
        request.on('close', unsubscribe);
        return;
      }
      if (method === 'GET' && serveStatic(pathname, response)) return;
      sendError(response, 404, 'Not found');
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
      sendError(response, status, error instanceof Error ? error.message : 'Unexpected error');
    }
  });

  return {
    listen(port = dependencies.config.port) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, dependencies.config.host, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          if (!address || typeof address === 'string') return reject(new Error('Unable to read server address'));
          resolve({ host: dependencies.config.host, port: address.port, url: `http://${dependencies.config.host === '::1' ? '[::1]' : dependencies.config.host}:${address.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  };
}
