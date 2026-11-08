import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent as HttpAgent, type ClientRequest, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Socket } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { AxiosProxyConfig } from 'axios';
import {
  resolveUpstreamProxy,
  type ResolvedUpstreamProxy,
} from '@/modules/config/upstream-proxy-agent';
import { UpstreamTransportCapacityError } from '../../common/exceptions/upstream-transport-capacity.exception';

export const GEMINI_TRANSPORT_LIMITS = {
  maxEntries: 16,
  maxRequests: 20,
  maxSockets: 20,
  maxFreeSockets: 4,
  idleMs: 90_000,
  keepAliveMsecs: 60_000,
};

type TransportLimits = typeof GEMINI_TRANSPORT_LIMITS;
type ConnectOptions = Parameters<HttpsProxyAgent<string>['connect']>[1];
const connectionSignals = new AsyncLocalStorage<AbortSignal>();

function agentOptions(limits: TransportLimits) {
  return {
    keepAlive: true,
    maxSockets: limits.maxSockets,
    maxTotalSockets: limits.maxSockets,
    maxFreeSockets: limits.maxFreeSockets,
    keepAliveMsecs: limits.keepAliveMsecs,
  };
}

export function withGeminiConnectionSignal<T>(
  signal: AbortSignal,
  execute: () => Promise<T>,
): Promise<T> {
  return connectionSignals.run(signal, execute);
}

/** Connection-local cancellation keeps a pooled agent independent of any earlier request. */
class PooledProxyAgent extends HttpsProxyAgent<string> {
  private readonly connecting = new Set<AbortController>();
  private readonly requestSignals = new WeakMap<ClientRequest, AbortSignal>();

  constructor(proxy: ResolvedUpstreamProxy, limits: TransportLimits) {
    super(proxy.endpoint, { ...agentOptions(limits), headers: proxy.headers });
  }

  // Bind before Node queues the request. A later socket callback can run in another request's context.
  addRequest(request: ClientRequest, options: RequestOptions): void {
    const signal = connectionSignals.getStore();
    if (signal) {
      this.requestSignals.set(request, signal);
    }
    // Node's Agent hook is available at runtime but omitted from its public type declarations.
    const dispatch: unknown = Reflect.get(HttpAgent.prototype, 'addRequest');
    if (typeof dispatch !== 'function') {
      throw new Error('Node HTTP Agent request dispatch is unavailable');
    }
    Reflect.apply(dispatch, this, [request, options]);
  }

  override async connect(request: ClientRequest, options: ConnectOptions): Promise<Socket> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const signal = this.requestSignals.get(request);
    this.connecting.add(controller);
    request.once('close', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    if (request.destroyed || signal?.aborted) {
      cancel();
    }
    const connector = new HttpsProxyAgent(this.proxy, {
      headers: this.proxyHeaders,
      signal: controller.signal,
    });
    try {
      return await connector.connect(request, options);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      request.removeListener('close', cancel);
      signal?.removeEventListener('abort', cancel);
      this.requestSignals.delete(request);
      this.connecting.delete(controller);
    }
  }

  override destroy(): void {
    for (const controller of this.connecting) {
      controller.abort();
    }
    super.destroy();
  }
}

interface TransportEntry {
  key: string;
  httpAgent: HttpAgent;
  httpsAgent: HttpAgent;
  active: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface GeminiTransportLease {
  httpAgent: HttpAgent;
  httpsAgent: HttpAgent;
  release(): void;
}

export class GeminiTransportPool {
  private readonly entries = new Map<string, TransportEntry>();
  private closed = false;

  constructor(private readonly limits: TransportLimits = GEMINI_TRANSPORT_LIMITS) {}

  acquire(url: string, proxy?: AxiosProxyConfig | false): GeminiTransportLease {
    if (this.closed) {
      throw new UpstreamTransportCapacityError();
    }
    const resolved = resolveUpstreamProxy(url, proxy);
    const key = resolved
      ? createHash('sha256')
          .update(JSON.stringify([resolved.endpoint.href, resolved.headers]))
          .digest('hex')
      : 'direct';
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.limits.maxEntries) {
        const idle = Array.from(this.entries.values()).find((candidate) => candidate.active === 0);
        if (!idle) {
          throw new UpstreamTransportCapacityError();
        }
        this.remove(idle);
      }
      const options = agentOptions(this.limits);
      const httpAgent = resolved
        ? new PooledProxyAgent(resolved, this.limits)
        : new HttpAgent(options);
      const httpsAgent = resolved ? httpAgent : new HttpsAgent(options);
      for (const agent of new Set([httpAgent, httpsAgent])) {
        agent.maxTotalSockets = this.limits.maxSockets;
        agent.on('free', (socket: Socket) => {
          if (Object.values(agent.freeSockets).some((sockets) => sockets?.includes(socket))) {
            socket.setTimeout(this.limits.idleMs);
          }
        });
      }
      entry = { key, httpAgent, httpsAgent, active: 0 };
    }
    if (entry.active >= this.limits.maxRequests) {
      throw new UpstreamTransportCapacityError();
    }
    clearTimeout(entry.idleTimer);
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.active++;
    let released = false;
    const acquired = entry;
    return {
      httpAgent: entry.httpAgent,
      httpsAgent: entry.httpsAgent,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        acquired.active--;
        if (acquired.active === 0 && !this.closed) {
          acquired.idleTimer = setTimeout(() => this.remove(acquired), this.limits.idleMs);
          acquired.idleTimer.unref();
        }
      },
    };
  }

  private remove(entry: TransportEntry): void {
    clearTimeout(entry.idleTimer);
    this.entries.delete(entry.key);
    entry.httpAgent.destroy();
    if (entry.httpsAgent !== entry.httpAgent) {
      entry.httpsAgent.destroy();
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      this.remove(entry);
    }
  }
}
