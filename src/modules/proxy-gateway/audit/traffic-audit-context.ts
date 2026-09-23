import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Transform, type Readable } from 'node:stream';
import { Observable } from 'rxjs';

import {
  trafficAuditService,
  type AuditSseBodyWriter,
  type AuditHandle,
  type UpstreamAttemptHandle,
} from './traffic-audit.service';
import type {
  CompleteUpstreamAttemptInput,
  StartUpstreamAttemptInput,
} from './traffic-audit.types';
import { classifyHttpTraffic } from './traffic-classifier';
import { IncrementalSseRedactor } from './incremental-sse-redactor';
import { auditJsonObject, parseAuditJsonBody } from './audit-json-object';
import {
  firstHeader,
  inferProtocol,
  isAuditManagementRoute,
  resolveHttpOutcome,
  resolveStableSessionId,
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
  attemptSequence: number;
  currentAccountId?: string | null;
  parent: AuditHandle | null;
  responseUsage?: AuditUsage;
  upstreamUsage?: AuditUsage;
  thoughtSessionKey: string;
  thoughtSessionStable: boolean;
  proxyTiming?: ProxyResponseTimingState;
  clientSessionId?: string;
}

export interface ProxyResponseTimingState {
  startedAt: number;
  cleanMs: number | null;
  normalizationStartedAt: number | null;
  normMs: number | null;
  thinkingMs: number;
  upstreamStartedAt: number | null;
  ttftMs: number | null;
}

interface HttpAuditState extends TrafficAuditRequestContext {
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
  options: { error?: unknown; partial?: boolean } = {},
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
): Pick<TrafficAuditRequestContext, 'clientSessionId' | 'proxyTiming'> | undefined {
  if (request) {
    return requestStates.get(requestStateKey(request)) ?? requestContextStorage.getStore();
  }
  return requestContextStorage.getStore();
}

export function runWithTrafficAuditRequestContext<TResult>(
  context: TrafficAuditRequestContext,
  callback: () => TResult,
): TResult {
  return requestContextStorage.run(context, callback);
}

export function startCurrentUpstreamAttempt(
  input: StartUpstreamAttemptInput,
): UpstreamAttemptHandle | null {
  const context = getTrafficAuditRequestContext();
  if (!context) {
    return null;
  }
  context.attemptSequence += 1;
  return trafficAuditService.startAttempt(context.parent, context.attemptSequence, {
    ...input,
    accountId: input.accountId ?? context.currentAccountId ?? undefined,
  });
}

export function setCurrentAuditAccountId(accountId: string | null): void {
  const context = getTrafficAuditRequestContext();
  if (context) {
    context.currentAccountId = accountId;
  }
}

/** Capture upstream usage that may be intentionally omitted from a client-compatible response. */
export function captureCurrentAuditUsage(value: unknown): void {
  const context = getTrafficAuditRequestContext();
  if (context) {
    context.upstreamUsage = mergeAuditUsage(context.upstreamUsage, extractAuditUsage(value));
  }
}

export function completeCurrentUpstreamAttempt(
  handle: UpstreamAttemptHandle | null,
  input: CompleteUpstreamAttemptInput,
): void {
  trafficAuditService.completeAttempt(handle, input);
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
    const stateKey = requestStateKey(request);
    completedRequestKeys.delete(stateKey);
    requestStates.set(stateKey, state);
    request.raw.once('aborted', () => {
      if (!state.parent) {
        state.parent = startHttpParent(request);
      }
      state.responsePartial = true;
      completeHttpAuditState(state, reply, 'client_cancelled', 499);
    });
  });

  instance.addHook('preHandler', async (request) => {
    const state = requestStates.get(requestStateKey(request));
    if (!state || state.parent) {
      return;
    }
    refreshThoughtSession(state);
    state.parent = startHttpParent(request);
  });

  instance.addHook('onSend', async (request, reply, payload) => {
    const state = requestStates.get(requestStateKey(request));
    if (!state) {
      return payload;
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
    const state = ensureHttpState(request);
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
  const status = statusOverride ?? reply.statusCode;
  const usage = mergeAuditUsage(
    mergeAuditUsage(state.responseUsage, extractAuditUsage(state.responseBody)),
    state.upstreamUsage,
  );
  trafficAuditService.completeParent(state.parent, {
    error: state.error,
    outcome: outcome ?? resolveHttpOutcome(status, state.error),
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
  const stateKey = requestStateKey(state.request);
  completedRequestKeys.add(stateKey);
  requestStates.delete(stateKey);
}

function ensureHttpState(request: FastifyRequest | null | undefined): HttpAuditState | undefined {
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
  if (state && !state.parent) {
    refreshThoughtSession(state);
    state.parent = startHttpParent(request);
  }
  return state;
}

function createProxyResponseTimingState(): ProxyResponseTimingState {
  return {
    cleanMs: null,
    normMs: null,
    normalizationStartedAt: null,
    startedAt: performance.now(),
    thinkingMs: 0,
    ttftMs: null,
    upstreamStartedAt: null,
  };
}

function startHttpParent(request: FastifyRequest): AuditHandle | null {
  const headers = request.headers;
  const forwarded = firstHeader(headers['x-forwarded-for'])?.split(',')[0]?.trim();
  const clientIp = forwarded || firstHeader(headers['x-real-ip']) || request.ip;
  const protocol = inferProtocol(request.url);
  const url = request.url;
  return trafficAuditService.startParent({
    clientIp,
    headers,
    method: request.method,
    protocol,
    query: auditJsonObject(request.query) ?? undefined,
    requestBody: request.body,
    sessionId: resolveStableSessionId(request) ?? undefined,
    trafficClass: classifyHttpTraffic(request.method, url),
    url,
  });
}

function refreshThoughtSession(state: HttpAuditState): void {
  const session = resolveThoughtSession(state.request, state.clientSessionId);
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
