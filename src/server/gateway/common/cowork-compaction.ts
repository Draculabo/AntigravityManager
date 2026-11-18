import { createHash } from 'node:crypto';
import { Observable } from 'rxjs';
import type { CoworkCompactionConfig } from '@/modules/config/types';
import { getServerConfig } from '@/server/server-config';
import { extractApiKeyToken } from '../guards/api-key-auth.util';
import { resolveClientSessionHint } from './client-session-hint';
import {
  ContextCompactionCoordinator,
  resolveCompactionPolicy,
  resolveManualCompactionCommand,
  type CompactionHistoryProof,
  type CompactionOperation,
} from './context-compaction';
import { CoworkCompactionControl } from './cowork-compaction-control';
import {
  hasCoworkCommandAfterReminders,
  matchCoworkPrefixSummary,
  matchesCoworkRetainedHistory,
  trackCoworkHistory,
} from './cowork-partial-history';
import { observeCoworkSummary, summaryTextFingerprint } from './cowork-summary-observer';
import type {
  AnthropicChatRequest,
  AnthropicChatResponse,
  AnthropicMessage,
} from './interfaces/request-interfaces';
import type { GeminiInternalRequest } from '../../../modules/proxy-gateway/antigravity/types';
import { estimateRequestContext, type RequestContextEstimate } from './request-context-estimate';
import { hashSessionAnchor } from './session-anchor-hash';
import { tenantIdentity, type SignatureScopeContext } from './signature-session-scope';

const coordinator = new ContextCompactionCoordinator();
let generation = 0;

function messageText(message: AnthropicMessage | undefined): string | null {
  if (!message || message.role !== 'user') {
    return null;
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (message.content.some((block) => block.type !== 'text')) {
    return null;
  }
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function hasNativeSummaryPrompt(text: string | null): boolean {
  return /^(?:Summarize this coding conversation|summarize the conversation so far|write a concise summary|You are tasked with summarizing conversations)(?:\b|[.!:])/u.test(
    text?.trimStart() ?? '',
  );
}

function isNativeSummary(request: AnthropicChatRequest, context: SignatureScopeContext): boolean {
  const helper = context.headers['x-stainless-helper'];
  if (typeof helper === 'string' && helper.toLowerCase().includes('compaction')) {
    return true;
  }
  return hasNativeSummaryPrompt(messageText(request.messages.at(-1)));
}

function hasSystemSummaryPrompt(system: AnthropicChatRequest['system']): boolean {
  return typeof system === 'string'
    ? hasNativeSummaryPrompt(system)
    : (system?.some((block) => block.type === 'text' && hasNativeSummaryPrompt(block.text)) ??
        false);
}

function hasAdoptedSummary(history: AnthropicMessage[], operation: CompactionOperation): boolean {
  if (!operation.providerSummaryFingerprint || !operation.providerSummaryCharacters) {
    return false;
  }
  for (const [index, message] of history.slice(0, 5).entries()) {
    // Cowork prepends complete reminder blocks before its continuation envelope.
    const text =
      messageText(message)
        ?.replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/u, '')
        .trim() ?? '';
    if (!text.startsWith('This session is being continued from a previous conversation')) {
      continue;
    }
    if (
      operation.retainedHistory &&
      !matchesCoworkRetainedHistory(history, index + 1, operation.retainedHistory)
    ) {
      continue;
    }
    const tagged = /<summary>([\s\S]*?)<\/summary>/u.exec(text)?.[1]?.trim();
    if (tagged && summaryTextFingerprint(tagged) === operation.providerSummaryFingerprint) {
      return true;
    }
    // Native clients can append the returned summary after the continuation preamble.
    // Compare exact provider text at paragraph boundaries, never summary keywords alone.
    let start = text.indexOf('\n');
    for (let attempt = 0; start >= 0 && attempt < 32; attempt++) {
      while (/\s/u.test(text.charAt(start))) {
        start++;
      }
      const candidate = text.slice(start, start + operation.providerSummaryCharacters);
      if (summaryTextFingerprint(candidate) === operation.providerSummaryFingerprint) {
        return true;
      }
      start = text.indexOf('\n', start);
    }
  }
  return false;
}

/** The configured credential scope opts into Cowork semantics, not a claimed process identity. */
export function createCoworkCompactionRequest(
  request: AnthropicChatRequest,
  context: SignatureScopeContext | undefined,
  signal?: AbortSignal,
): CoworkCompactionRequest | undefined {
  const config = getServerConfig();
  const settings = config?.cowork_compaction;
  if (!context || !settings || (!settings.auto_enabled && !settings.manual_enabled)) {
    return undefined;
  }
  if (context.url?.split('?', 1)[0] !== '/v1/messages') {
    return undefined;
  }
  const key = extractApiKeyToken(context.headers);
  if (!key || !config.api_key?.trim() || key !== config.api_key) {
    return undefined;
  }
  const credentialHash = createHash('sha256').update(key).digest('hex');
  if (!settings.trusted_client_key_hashes?.includes(credentialHash)) {
    return undefined;
  }
  const hint = resolveClientSessionHint(context.headers, context.url, request, request.metadata);
  if (!hint.id || hint.diagnostics.source === 'legacy-user') {
    return undefined;
  }
  return new CoworkCompactionRequest(
    request,
    context,
    settings,
    tenantIdentity(context.headers),
    hint.id,
    signal,
  );
}

export function clearCoworkCompactionState(): void {
  coordinator.clear();
}

export class CoworkCompactionRequest {
  private summaryOperationId: string | undefined;
  private retainedHistory: CompactionHistoryProof | undefined;
  private admitted = false;
  private readonly manual: boolean;
  private readonly summary: boolean;
  private readonly history: AnthropicMessage[];
  private readonly fingerprint: string;
  private readonly onAbort = (): void => {
    this.fail();
  };

  constructor(
    private readonly request: AnthropicChatRequest,
    context: SignatureScopeContext,
    private readonly settings: CoworkCompactionConfig,
    private readonly tenantId: string,
    private readonly clientSessionId: string,
    private readonly signal?: AbortSignal,
  ) {
    this.summary = isNativeSummary(request, context);
    const last = request.messages.at(-1);
    this.manual =
      !this.summary &&
      (resolveManualCompactionCommand(messageText(last) ?? '') !== null ||
        hasCoworkCommandAfterReminders(last));
    this.history = this.manual ? request.messages.slice(0, -1) : request.messages;
    this.fingerprint = hashSessionAnchor(this.history);
  }

  public admit = (body: GeminiInternalRequest, estimate: RequestContextEstimate): void => {
    if (this.admitted) {
      return;
    }
    this.admitted = true;
    const operation = coordinator.getOperation(this.tenantId, this.clientSessionId);
    if (operation?.status === 'active') {
      const fullHistorySummary =
        (this.summary || hasSystemSummaryPrompt(this.request.system)) &&
        operation.inputHistoryMessages !== undefined &&
        hashSessionAnchor(this.request.messages.slice(0, operation.inputHistoryMessages)) ===
          operation.inputFingerprint;
      const retainedHistory = fullHistorySummary
        ? undefined
        : matchCoworkPrefixSummary(this.request.messages, operation.inputHistory);
      if (fullHistorySummary || retainedHistory) {
        this.summaryOperationId = coordinator.markSummaryInFlight(operation.id)?.id;
        if (this.summaryOperationId) {
          this.retainedHistory = retainedHistory;
          this.signal?.addEventListener('abort', this.onAbort, { once: true });
          if (this.signal?.aborted) {
            this.fail();
          }
        }
        return;
      }
    }
    if (this.summary) {
      return;
    }
    if (this.manual && !this.settings.manual_enabled) {
      return;
    }
    if (operation?.status === 'summary-succeeded' && hasAdoptedSummary(this.history, operation)) {
      const confirmation = coordinator.complete({
        operationId: operation.id,
        newHistoryFingerprint: this.fingerprint,
        newEstimatedInputTokens: estimate.estimatedInputTokens,
        newHistoryMessages: this.history.length,
      });
      if (confirmation) {
        if (operation.mode === 'manual' && (!operation.retainedHistory || this.manual)) {
          throw new CoworkCompactionControl({
            kind: 'acknowledgement',
            operationId: operation.id,
            message: `Compacted conversation. Saved approximately ${confirmation.savedEstimatedTokens} estimated input tokens.`,
          });
        }
        this.renewProtection();
        return;
      }
    }
    if (!this.manual && this.renewProtection()) {
      return;
    }
    if (operation) {
      if (operation.status === 'active' && this.fingerprint === operation.inputFingerprint) {
        this.trigger(operation);
      }
      return;
    }
    const fixed = estimateRequestContext({ ...body, request: { ...body.request, contents: [] } });
    const policy = resolveCompactionPolicy({
      fixedOverheadTokens: fixed.estimatedInputTokens,
      configuredThreshold: this.settings.auto_threshold,
      estimatedInputTokens: estimate.estimatedInputTokens,
    });
    if (this.manual && estimate.estimatedInputTokens <= policy.targetTokens) {
      throw new CoworkCompactionControl({
        kind: 'acknowledgement',
        message:
          estimate.unestimatedMediaParts > 0
            ? 'Context size cannot be estimated reliably because this request contains uncounted media. No compaction was performed.'
            : 'Conversation is already at minimal context. No compaction was performed.',
      });
    }
    if (
      !this.manual &&
      (!this.settings.auto_enabled ||
        !policy.shouldAutoCompact ||
        estimate.unestimatedMediaParts > 0)
    ) {
      return;
    }
    const acquired = coordinator.acquire({
      tenantId: this.tenantId,
      clientSessionId: this.clientSessionId,
      generation: ++generation,
      source: 'cowork',
      mode: this.manual ? 'manual' : 'auto',
      estimatedInputTokens: estimate.estimatedInputTokens,
      targetTokens: policy.targetTokens,
      inputFingerprint: this.fingerprint,
      inputHistoryMessages: this.history.length,
      inputHistory: trackCoworkHistory(this.history),
    });
    if (acquired.kind !== 'rejected') {
      this.trigger(acquired.operation);
    }
  };

  public observe(
    result: AnthropicChatResponse | Observable<string>,
  ): AnthropicChatResponse | Observable<string> {
    const operationId = this.summaryOperationId;
    if (!operationId) {
      return result;
    }
    return observeCoworkSummary(
      result,
      (proof) => {
        this.signal?.removeEventListener('abort', this.onAbort);
        coordinator.markProviderSummarySucceeded({
          operationId,
          summaryFingerprint: proof.fingerprint,
          summaryCharacters: proof.characters,
          retainedHistory: this.retainedHistory,
        });
      },
      () => {
        this.fail();
      },
    );
  }

  public fail(): void {
    this.signal?.removeEventListener('abort', this.onAbort);
    if (this.summaryOperationId) {
      coordinator.fail(this.summaryOperationId);
    }
  }

  private renewProtection(): boolean {
    const protection = coordinator.getProtection(this.tenantId, this.clientSessionId);
    if (!protection || protection.adoptedHistoryMessages === undefined) {
      return false;
    }
    const root = hashSessionAnchor(this.history.slice(0, protection.adoptedHistoryMessages));
    if (root !== protection.adoptedHistoryFingerprint) {
      coordinator.invalidate(this.tenantId, this.clientSessionId);
      return false;
    }
    return coordinator.continue({ ...protection, adoptedHistoryFingerprint: root }) !== null;
  }

  private trigger(operation: CompactionOperation): never {
    throw new CoworkCompactionControl({
      kind: 'trigger',
      operationId: operation.id,
      estimatedInputTokens: operation.beforeTokens,
      targetTokens: operation.targetTokens,
    });
  }
}
