import {
  runWithTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from '../../../../../modules/proxy-gateway/audit/traffic-audit-context';
import { resolveThoughtSession } from '../../../../../modules/proxy-gateway/audit/traffic-audit-http-metadata';
import { thoughtCaptureLeases } from '../../../../../modules/proxy-gateway/thought-store/thought-capture-leases';
import type { SignatureScopeContext } from '../../../common/signature-session-scope';
import { OpenAIResponsesWebSocketProtocol } from './openai-responses-websocket.protocol';
import { registerActiveResponsesHistory } from './responses-thought-recovery';

/** One connection owns one current transcript; only an executing frame holds a request lease. */
export class ResponsesThoughtContext {
  private retainedScope?: { key: string; stable: boolean };
  private active?: TrafficAuditRequestContext;
  private closed = false;
  private readonly unregister: () => void;

  public constructor(private readonly protocol: OpenAIResponsesWebSocketProtocol) {
    this.unregister = registerActiveResponsesHistory((key) => {
      const scope = this.active?.thoughtSessionKey ?? this.retainedScope?.key;
      if (key !== undefined && scope !== key) {
        return { removed: 0, unknown: scope === undefined && this.protocol.hasHistory() ? 1 : 0 };
      }
      const removed = this.protocol.hasHistory() ? 1 : 0;
      this.protocol.dispose();
      this.retainedScope = undefined;
      return { removed, unknown: 0 };
    });
  }

  public async run<T>(
    payload: unknown,
    transport: SignatureScopeContext,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      throw new Error('Responses WebSocket connection is closed');
    }
    const session = resolveThoughtSession({
      headers: transport.headers ?? {},
      url: transport.url ?? '/v1/responses',
      body: payload,
    });
    const previous = this.retainedScope;
    if (session.stable && previous && session.key !== previous.key) {
      this.protocol.dispose();
      this.retainedScope = undefined;
    }
    const scope = session.stable
      ? { key: session.key, stable: true }
      : (this.retainedScope ?? { key: session.key, stable: false });
    const context: TrafficAuditRequestContext = {
      attemptSequence: 0,
      parent: null,
      thoughtSessionKey: scope.key,
      thoughtSessionStable: scope.stable,
      thoughtCaptureLease: thoughtCaptureLeases.acquire(scope.key),
    };
    this.active = context;
    try {
      return await runWithTrafficAuditRequestContext(context, async () => {
        const result = await work();
        if (context.thoughtCaptureLease?.valid === false) {
          this.protocol.dispose();
          throw new Error('Responses history was invalidated');
        }
        return result;
      });
    } finally {
      if (context.thoughtCaptureLease?.valid && !this.closed) {
        this.retainedScope = {
          key: context.thoughtSessionKey,
          stable: context.thoughtSessionStable,
        };
      } else {
        this.protocol.dispose();
      }
      context.thoughtCaptureLease?.release();
      this.active = undefined;
    }
  }

  public mayRetain(): boolean {
    return !this.closed && this.active?.thoughtCaptureLease?.valid === true;
  }

  public dispose(): void {
    this.closed = true;
    this.unregister();
    this.active?.thoughtCaptureLease?.release();
    this.protocol.dispose();
    this.retainedScope = undefined;
  }
}
