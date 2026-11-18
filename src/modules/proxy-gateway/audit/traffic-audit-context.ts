import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { PromptTransformationState } from '../../../server/gateway/common/prompt-transformation-diagnostics';
import type { ThoughtRestoreDiagnostics } from '../thought-store/thought-restore-diagnostics';
import type { SignatureSessionScope } from '../../../server/gateway/common/signature-session-scope';
import {
  thoughtCaptureLeases,
  type ThoughtCaptureLease,
} from '../thought-store/thought-capture-leases';
import { Transform, type Readable } from 'node:stream';
import { Observable } from 'rxjs';
import { evaluateClientAddress } from '@/shared/network/client-address';
import { getServerConfig } from '@/server/server-config';

import {
  trafficAuditService,
  type AuditSseBodyWriter,
  type AuditHandle,
} from './traffic-audit.service';
import type {
  CompleteUpstreamAttemptInput,
  StartUpstreamAttemptInput,
} from './traffic-audit.types';
import { classifyHttpTraffic } from './traffic-classifier';
import { isSuccessfulProbeCandidate } from './audit-probe-policy';
import { IncrementalSseRedactor } from './incremental-sse-redactor';
import { auditJsonObject, parseAuditJsonBody } from './audit-json-object';
import { isFailedAuditAttempt } from './audit-attempt-outcome';
import { captureGatewayErrorDiagnostic } from './gateway-error-diagnostic';
import {
  createCurrentUpstreamAttempt,
  completeUpstreamAttemptDiagnostic,
  captureUpstreamAttemptUsage,
  currentUpstreamAttemptUsage,
  isUpstreamAttemptUsagePartial,
  type CurrentUpstreamAttemptHandle,
} from './upstream-attempt-diagnostics';
export type { CurrentUpstreamAttemptHandle } from './upstream-attempt-diagnostics';
export { captureUpstreamAttemptUsage } from './upstream-attempt-diagnostics';

import { resolveAuditSessionId } from './audit-session-identity';
import {
  inferProtocol,
  isAuditManagementRoute,
  resolveHttpOutcome,
  resolveThoughtSession,
} from './traffic-audit-http-metadata';
import { extractAuditUsage, mergeAuditUsage, type AuditUsage } from './audit-usage';
import {
  detectAuditOutputModalities,
  mergeAuditOutputModalities,
  type AuditOutputModalities,
} from './audit-output-modality';

export { normalizeSseForAudit } from './normalize-sse-for-audit';
export { createThoughtSessionKey } from './traffic-audit-http-metadata';

export interface TrafficAuditRequestContext {
  thoughtCaptureLease?: ThoughtCaptureLease;
  auditSessionId?: string;
  promptTransformations?: PromptTransformationState;
  thoughtRestore?: ThoughtRestoreDiagnostics;
  attemptSequence: number;
  failedAttemptCount?: number;
  currentAccountId?: string | null;
  currentAccountGenerationHash?: string;
  currentAccountSubjectHash?: string;
  currentAccountGrantHash?: string;
  currentAccountEmail?: string | null;
  parent: AuditHandle | null;
  responseUsage?: AuditUsage;
  upstreamUsage?: AuditUsage;
  thoughtSessionKey: string;
  thoughtSessionStable: boolean;
  thoughtSessionResolved?: boolean;
  proxyTiming?: ProxyResponseTimingState;
  clientSessionId?: string;
}

export interface ProxyResponseTimingState {
  startedAt: number;
  cleanMs: number | null;
  normalizationStartedAt: number | null;
  normMs: number | null;
  thinkingMs: number | null;
  upstreamStartedAt: number | null;
  ttftMs: number | null;
}

interface HttpAuditState extends TrafficAuditRequestContext {
  auditGeneration: number;
  auditStartedAt: number;
  deferProbe: boolean;
  clientSessionId: string;
  proxyTiming: ProxyResponseTimingState;
  captureClosing?: boolean;
  completed: boolean;
  error?: unknown;
  hijackedResponseBytes?: number;
  request: FastifyRequest;
  responseBody?: unknown;
  outputModalities?: AuditOutputModalities | null;
  responseCapture?: Promise<void>;
  responsePartial: boolean;
  sseRedactor?: IncrementalSseRedactor;
  sseWriter?: AuditSseBodyWriter | null;
}

const requestContextStorage = new AsyncLocalStorage<TrafficAuditRequestContext>();
const requestStates = new WeakMap<object, HttpAuditState>();
const completedRequestKeys = new WeakSet<object>();

function requestStateKey(request: object): object {
  const raw = Reflect.get(request, 'raw');
  return raw && typeof raw === 'object' ? raw : request;
}

export function captureHijackedHttpResponseChunk(
  request: FastifyRequest | null | undefined,
  chunk: string | Buffer,
): void {
  const state = ensureHttpState(request);
  if (!state || state.completed || state.captureClosing) {
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.hijackedResponseBytes = (state.hijackedResponseBytes ?? 0) + buffer.byteLength;
  const redactor = (state.sseRedactor ??= createStateSseRedactor(state));
  state.sseWriter ??= trafficAuditService.beginParentSse(state.parent);
  for (const sanitized of redactor.push(buffer)) {
    if (!state.sseWriter?.write(sanitized)) {
      state.responsePartial = true;
    }
  }
}

export function completeHijackedHttpResponse(
  request: FastifyRequest | null | undefined,
  reply: FastifyReply,
  options: { error?: unknown; partial?: boolean; body?: unknown } = {},
): void {
  const state = ensureHttpState(request);
  if (!state || state.completed) {
    return;
  }
  state.captureClosing = true;
  const final = state.sseRedactor?.finish();
  for (const sanitized of final?.chunks ?? []) {
    if (!state.sseWriter?.write(sanitized)) {
      state.responsePartial = true;
    }
  }
  const transportPartial = options.partial === true && final?.result.terminalEventSeen !== true;
  state.responsePartial = state.responsePartial || transportPartial;
  if (options.error) {
    state.error = options.error;
  }
  if (options.body !== undefined) {
    state.responseBody = options.body;
  }
  state.responseCapture = state.sseWriter?.finish({
    errorSummary: final?.result.errorSummary,
    parseErrorOffset: final?.result.parseErrorOffset,
    partial: state.responsePartial,
    rawBytes: state.hijackedResponseBytes ?? 0,
    terminalStatus: options.error
      ? 'upstream_error'
      : state.responsePartial
        ? 'client_disconnected'
        : 'completed',
  });
  completeHttpAuditStateAfterCapture(state, reply);
}

export function getTrafficAuditRequestContext(): TrafficAuditRequestContext | undefined {
  return requestContextStorage.getStore();
}

export function getProxyResponseTimingContext(
  request?: FastifyRequest,
):
  | Pick<
      TrafficAuditRequestContext,
      | 'clientSessionId'
      | 'proxyTiming'
      | 'currentAccountId'
      | 'currentAccountEmail'
      | 'attemptSequence'
      | 'failedAttemptCount'
    >
  | undefined {
  if (request) {
    return requestStates.get(requestStateKey(request)) ?? requestContextStorage.getStore();
  }
  return requestContextStorage.getStore();
}

export function runWithTrafficAuditRequestContext<TResult>(
  context: TrafficAuditRequestContext,
  callback: () => TResult,
): TResult {
  context.thoughtCaptureLease ??= thoughtCaptureLeases.acquire(context.thoughtSessionKey);
  return requestContextStorage.run(context, callback);
}

export function startCurrentUpstreamAttempt(
  input: StartUpstreamAttemptInput,
): CurrentUpstreamAttemptHandle {
  const context = getTrafficAuditRequestContext();
  const snapshot = {
    ...input,
    accountId: input.accountId ?? context?.currentAccountId ?? undefined,
    accountGenerationHash:
      input.accountGenerationHash ??
      (input.accountId === undefined || input.accountId === context?.currentAccountId
        ? context?.currentAccountGenerationHash
        : undefined),
    accountSubjectHash:
      input.accountSubjectHash ??
      (input.accountId === undefined || input.accountId === context?.currentAccountId
        ? context?.currentAccountSubjectHash
        : undefined),
    accountGrantHash:
      input.accountGrantHash ??
      (input.accountId === undefined || input.accountId === context?.currentAccountId
        ? context?.currentAccountGrantHash
        : undefined),
  };
  if (!context) {
    return createCurrentUpstreamAttempt(null, input.operation, undefined, snapshot);
  }
  context.attemptSequence += 1;
  const audit = trafficAuditService.startAttempt(context.parent, context.attemptSequence, snapshot);
  return createCurrentUpstreamAttempt(audit, input.operation, context.parent?.id, snapshot);
}

export function setCurrentAuditAccountId(
  accountId: string | null,
  accountEmail?: string | null,
  lifecycleGeneration?: string,
  subjectHash?: string,
  grantHash?: string,
): void {
  const context = getTrafficAuditRequestContext();
  if (context) {
    context.currentAccountId = accountId;
    context.currentAccountGenerationHash = lifecycleGeneration
      ? createHash('sha256').update(lifecycleGeneration).digest('hex')
      : undefined;
    context.currentAccountSubjectHash = subjectHash;
    context.currentAccountGrantHash = grantHash;
    if (accountEmail !== undefined) {
      context.currentAccountEmail = accountEmail;
    }
  }
}

export const setCurrentAuditAccount = setCurrentAuditAccountId;

/** Capture upstream usage that may be intentionally omitted from a client-compatible response. */
export function captureCurrentAuditUsage(value: unknown): void {
  const context = getTrafficAuditRequestContext();
  if (context) {
    context.upstreamUsage = mergeAuditUsage(context.upstreamUsage, extractAuditUsage(value));
  }
}

/** Only protocol-owned D03 resolution may supply a restored/generated logical identity. */
export function captureCurrentAuditSession(scope: SignatureSessionScope): void {
  const context = getTrafficAuditRequestContext();
  if (context) {
    context.auditSessionId = scope.auditKey;
    bindCurrentThoughtRecoveryScope(scope.storeKey);
  }
}

/** Call only after the protocol has proved ownership of the restored history. */
export function bindCurrentThoughtRecoveryScope(sessionKey: string): void {
  const context = getTrafficAuditRequestContext();
  if (
    !context ||
    context.thoughtSessionStable ||
    context.thoughtSessionResolved ||
    context.thoughtCaptureLease?.valid === false
  ) {
    return;
  }
  if (context.thoughtSessionKey !== sessionKey) {
    context.thoughtCaptureLease?.release();
    context.thoughtSessionKey = sessionKey;
    context.thoughtCaptureLease = thoughtCaptureLeases.acquire(sessionKey);
  }
  context.thoughtSessionResolved = true;
}

export function completeCurrentUpstreamAttempt(
  handle: CurrentUpstreamAttemptHandle | null,
  input: CompleteUpstreamAttemptInput,
): void {
  captureUpstreamAttemptUsage(handle, input.responseBody);
  const usage = mergeAuditUsage(currentUpstreamAttemptUsage(handle), input.usage);
  if (handle && !completeUpstreamAttemptDiagnostic(handle, input)) {
    return;
  }
  const context = getTrafficAuditRequestContext();
  if (context && isFailedAuditAttempt(input)) {
    context.failedAttemptCount = (context.failedAttemptCount ?? 0) + 1;
  }
  trafficAuditService.completeAttempt(handle?.audit ?? null, {
    ...input,
    usage,
    partial: input.partial || isUpstreamAttemptUsagePartial(handle),
  });
}

/** Runs Nest handlers inside the request context created by the Fastify lifecycle hooks. */
@Injectable()
export class TrafficAuditContextInterceptor implements NestInterceptor {
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<object>();
    const state = requestStates.get(requestStateKey(request));
    if (!state) {
      return next.handle();
    }
    return new Observable((subscriber) =>
      requestContextStorage.run(state, () => next.handle().subscribe(subscriber)),
    );
  }
}

export function registerTrafficAuditHttpHooks(instance: FastifyInstance): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (isAuditManagementRoute(request.url)) {
      return;
    }
    const session = resolveThoughtSession(request);
    const state: HttpAuditState = {
      auditGeneration: trafficAuditService.captureGeneration(
        classifyHttpTraffic(request.method, request.url),
      ),
      auditStartedAt: Date.now(),
      deferProbe: deferProbeCapture(request),
      attemptSequence: 0,
      clientSessionId: session.clientId,
      completed: false,
      parent: null,
      proxyTiming: createProxyResponseTimingState(),
      request,
      responsePartial: false,
      thoughtSessionKey: session.key,
      thoughtSessionStable: session.stable,
      thoughtCaptureLease: thoughtCaptureLeases.acquire(session.key),
    };
    const stateKey = requestStateKey(request);
    completedRequestKeys.delete(stateKey);
    requestStates.set(stateKey, state);
    reply.raw.once('close', () => state.thoughtCaptureLease?.release());
    request.raw.once('aborted', () => {
      if (!state.parent) {
        state.parent = startHttpParent(request, state.auditStartedAt, state.auditGeneration);
      }
      state.responsePartial = true;
      completeHttpAuditState(state, reply, 'client_cancelled', 499);
    });
  });

  instance.addHook('preHandler', async (request) => {
    const state = requestStates.get(requestStateKey(request));
    if (!state || state.parent || state.deferProbe) {
      return;
    }
    refreshThoughtSession(state);
    state.parent = startHttpParent(request, state.auditStartedAt, state.auditGeneration);
  });

  instance.addHook('onSend', async (request, reply, payload) => {
    const state = requestStates.get(requestStateKey(request));
    if (!state) {
      return payload;
    }
    if (state.deferProbe && reply.statusCode >= 200 && reply.statusCode < 300 && !state.error) {
      return payload;
    }
    if (state.deferProbe) {
      state.deferProbe = false;
      state.parent = startHttpParent(request, state.auditStartedAt, state.auditGeneration);
    }
    if (isReadable(payload)) {
      const capturingStream = createCapturingTransform(payload, state);
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) {
          state.responsePartial = true;
          void completeHttpAuditStateAfterCapture(state, reply, 'client_disconnected');
        }
      });
      return capturingStream;
    }
    state.responseBody = parseAuditJsonBody(payload) ?? payload;
    return payload;
  });

  instance.addHook('onError', async (request, _reply, error) => {
    const state = ensureHttpState(request);
    if (state) {
      state.error = error;
    }
  });

  instance.addHook('onResponse', async (request, reply) => {
    const state = ensureHttpState(request, false);
    if (state) {
      await completeHttpAuditStateAfterCapture(state, reply);
    }
  });
}

async function completeHttpAuditStateAfterCapture(
  state: HttpAuditState,
  reply: FastifyReply,
  outcome?: 'client_cancelled' | 'client_disconnected',
  statusOverride?: number,
): Promise<void> {
  if (state.responseCapture) {
    await Promise.race([
      state.responseCapture,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2_000);
      }),
    ]);
  }
  completeHttpAuditState(state, reply, outcome, statusOverride);
}

function completeHttpAuditState(
  state: HttpAuditState,
  reply: FastifyReply,
  outcome?: 'client_cancelled' | 'client_disconnected',
  statusOverride?: number,
): void {
  if (state.completed) {
    return;
  }
  state.completed = true;
  state.thoughtCaptureLease?.release();
  const status = statusOverride ?? reply.statusCode;
  captureGatewayErrorDiagnostic({
    error: state.error,
    status,
    protocol: inferProtocol(state.request.url),
    requestId: state.parent?.id,
  });
  const suppress =
    state.deferProbe &&
    status >= 200 &&
    status < 300 &&
    !state.error &&
    !state.responsePartial &&
    !outcome;
  if (!suppress && !state.parent) {
    state.parent = startHttpParent(state.request, state.auditStartedAt, state.auditGeneration);
  }
  const usage = mergeAuditUsage(
    mergeAuditUsage(state.responseUsage, extractAuditUsage(state.responseBody)),
    state.upstreamUsage,
  );
  if (!suppress) {
    trafficAuditService.completeParent(state.parent, {
      sessionId: state.auditSessionId,
      error: state.error,
      outcome: outcome ?? resolveHttpOutcome(status, state.error ?? state.responseBody),
      partial: state.responsePartial,
      responseBody: state.responseBody,
      responseHeaders: reply.getHeaders(),
      responsePayloadHandled: Boolean(state.sseWriter),
      status,
      usage,
      outputModalities: mergeAuditOutputModalities(
        state.outputModalities ?? null,
        detectAuditOutputModalities(state.responseBody),
      ),
    });
  }
  const stateKey = requestStateKey(state.request);
  completedRequestKeys.add(stateKey);
  requestStates.delete(stateKey);
}

function ensureHttpState(
  request: FastifyRequest | null | undefined,
  admit = true,
): HttpAuditState | undefined {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  const stateKey = requestStateKey(request);
  if (completedRequestKeys.has(stateKey)) {
    return undefined;
  }
  let state = requestStates.get(stateKey);
  if (!state && !isAuditManagementRoute(request.url)) {
    const session = resolveThoughtSession(request);
    state = {
      auditGeneration: trafficAuditService.captureGeneration(
        classifyHttpTraffic(request.method, request.url),
      ),
      auditStartedAt: Date.now(),
      deferProbe: deferProbeCapture(request),
      attemptSequence: 0,
      clientSessionId: session.clientId,
      completed: false,
      parent: null,
      proxyTiming: createProxyResponseTimingState(),
      request,
      responsePartial: false,
      thoughtSessionKey: session.key,
      thoughtSessionStable: session.stable,
    };
    requestStates.set(stateKey, state);
  }
  if (state && !state.parent && admit) {
    state.deferProbe = false;
    refreshThoughtSession(state);
    state.parent = startHttpParent(request, state.auditStartedAt, state.auditGeneration);
  }
  return state;
}

function createProxyResponseTimingState(): ProxyResponseTimingState {
  return {
    cleanMs: null,
    normMs: null,
    normalizationStartedAt: null,
    startedAt: performance.now(),
    thinkingMs: null,
    ttftMs: null,
    upstreamStartedAt: null,
  };
}

function deferProbeCapture(request: FastifyRequest): boolean {
  return (
    !getServerConfig()?.traffic_audit.capture_successful_probes &&
    isSuccessfulProbeCandidate(request.method, request.url)
  );
}

function startHttpParent(
  request: FastifyRequest,
  startedAt: number,
  captureGeneration: number,
): AuditHandle | null {
  const headers = request.headers;
  const config = getServerConfig();
  const decision = config
    ? evaluateClientAddress(request.socket.remoteAddress ?? request.ip, headers, config.network)
    : null;
  const clientIp = decision?.clientAddress ?? request.ip;
  const protocol = inferProtocol(request.url);
  const url = request.url;
  return trafficAuditService.startParent({
    startedAt,
    captureGeneration,
    clientIp,
    headers,
    method: request.method,
    protocol,
    query: auditJsonObject(request.query) ?? undefined,
    requestBody: request.body,
    sessionId: resolveAuditSessionId(request),
    trafficClass: classifyHttpTraffic(request.method, url),
    url,
  });
}

function refreshThoughtSession(state: HttpAuditState): void {
  // A protocol-resolved hint-free scope supersedes the temporary HTTP entry key.
  if (state.thoughtSessionResolved) {
    return;
  }
  const session = resolveThoughtSession(state.request, state.clientSessionId);
  if (state.thoughtSessionKey !== session.key && state.thoughtCaptureLease?.valid !== false) {
    state.thoughtCaptureLease?.release();
    state.thoughtCaptureLease = thoughtCaptureLeases.acquire(session.key);
  }
  state.clientSessionId = session.clientId;
  state.thoughtSessionKey = session.key;
  state.thoughtSessionStable = session.stable;
}

function isReadable(value: unknown): value is Readable {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'pipe') === 'function' &&
    typeof Reflect.get(value, 'on') === 'function',
  );
}

function createCapturingTransform(payload: Readable, state: HttpAuditState): Transform {
  const redactor = createStateSseRedactor(state);
  const writer = trafficAuditService.beginParentSse(state.parent);
  state.sseRedactor = redactor;
  state.sseWriter = writer;
  let rawBytes = 0;
  let settled = false;
  let resolveCapture!: () => void;
  state.responseCapture = new Promise<void>((resolve) => {
    resolveCapture = resolve;
  });
  const finishCapture = async (partial: boolean, error?: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    const final = redactor.finish();
    for (const sanitized of final.chunks) {
      if (!writer?.write(sanitized)) {
        partial = true;
      }
    }
    const transportPartial = partial && !final.result.terminalEventSeen;
    state.responsePartial = state.responsePartial || transportPartial;
    if (error) {
      state.error = error;
    }
    await writer?.finish({
      errorSummary: final.result.errorSummary,
      parseErrorOffset: final.result.parseErrorOffset,
      partial: state.responsePartial,
      rawBytes,
      terminalStatus: error
        ? 'upstream_error'
        : state.responsePartial
          ? 'client_disconnected'
          : 'completed',
    });
    resolveCapture();
  };
  const transform = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rawBytes += buffer.byteLength;
      for (const sanitized of redactor.push(buffer)) {
        if (!writer?.write(sanitized)) {
          state.responsePartial = true;
        }
      }
      callback(null, chunk);
    },
  });
  transform.on('finish', () => void finishCapture(false));
  transform.on('error', (error) => {
    void finishCapture(true, error);
  });
  transform.on('close', () => void finishCapture(!transform.writableFinished));
  payload.pipe(transform);
  return transform;
}

function createStateSseRedactor(state: HttpAuditState): IncrementalSseRedactor {
  return new IncrementalSseRedactor({
    onParsedEvent: (event) => {
      state.outputModalities = mergeAuditOutputModalities(
        state.outputModalities ?? null,
        detectAuditOutputModalities(event),
      );
      state.responseUsage = mergeAuditUsage(state.responseUsage, extractAuditUsage(event));
    },
  });
}
