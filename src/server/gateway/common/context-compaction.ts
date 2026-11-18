import { createHash } from 'node:crypto';

export const CONTEXT_COMPACTION_ALGORITHM_VERSION = 'd13-v1';
export const DEFAULT_COWORK_AUTO_THRESHOLD = 200_000;
export const MIN_COWORK_AUTO_THRESHOLD = 50_000;
export const DEFAULT_COMPACTION_TTL_MS = 300_000;
export const DEFAULT_CONFIRMATION_TTL_MS = 60_000;
export const DEFAULT_MAX_ACTIVE_OPERATIONS = 1_000;
export const DEFAULT_MAX_CONFIRMATIONS = 1_000;
export const DEFAULT_MAX_PROTECTIONS = 1_000;
const PENDING_CONTINUATION_TTL_MS = 300_000;
const ACTIVE_CONTINUATION_TTL_MS = 30_000;

export type CompactionMode = 'manual' | 'auto';
export type CompactionSource = 'cowork' | 'unknown';
export type CompactionStatus = 'active' | 'summary-in-flight' | 'summary-succeeded' | 'completed';

export interface CoworkCompactionSettings {
  autoEnabled: boolean;
  manualEnabled: boolean;
  autoThreshold: number;
}

export interface CompactionPolicyInput {
  fixedOverheadTokens: number;
  configuredThreshold: number;
  estimatedInputTokens: number;
}

export interface CompactionPolicy {
  targetTokens: number;
  effectiveAutoThreshold: number;
  shouldAutoCompact: boolean;
}

export interface CompactionHistoryProof {
  messages: number;
  fingerprint: string;
}

export interface CompactionOperation {
  id: string;
  key: string;
  tenantId: string;
  clientSessionId: string;
  generation: number;
  mode: CompactionMode;
  source: CompactionSource;
  beforeTokens: number;
  targetTokens: number;
  algorithmVersion: string;
  inputFingerprint: string;
  inputHistoryMessages?: number;
  inputHistory?: readonly string[];
  retainedHistory?: CompactionHistoryProof;
  providerSummaryFingerprint?: string;
  providerSummaryCharacters?: number;
  status: CompactionStatus;
  createdAt: number;
  expiresAt: number;
}

export interface CompactionRequest {
  tenantId: string;
  clientSessionId: string;
  generation: number;
  mode: CompactionMode;
  source: CompactionSource;
  estimatedInputTokens: number;
  targetTokens: number;
  inputFingerprint: string;
  inputHistoryMessages?: number;
  inputHistory?: readonly string[];
  now?: number;
}

export type AcquireResult =
  | { kind: 'acquired'; operation: CompactionOperation }
  | { kind: 'reused'; operation: CompactionOperation }
  | { kind: 'rejected'; reason: 'capacity' | 'below-target' | 'untrusted-source' };

export interface CompactionContinuation {
  tenantId: string;
  clientSessionId: string;
  generation: number;
  operationId: string;
  adoptedHistoryFingerprint: string;
}

export interface CompactionProtection extends CompactionContinuation {
  adoptedHistoryMessages?: number;
  activated: boolean;
  expiresAt: number;
}

export interface CompletionInput {
  operationId: string;
  newHistoryFingerprint: string;
  newEstimatedInputTokens: number;
  newHistoryMessages?: number;
  now?: number;
}

export interface ProviderSummarySuccessInput {
  operationId: string;
  summaryFingerprint: string;
  summaryCharacters?: number;
  retainedHistory?: CompactionHistoryProof;
  now?: number;
}

export interface CompactionConfirmation {
  operationId: string;
  historyFingerprint: string;
  beforeTokens: number;
  afterTokens: number;
  savedEstimatedTokens: number;
  createdAt: number;
  expiresAt: number;
}

export function fingerprintCompactionInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

export function resolveCompactionPolicy(input: CompactionPolicyInput): CompactionPolicy {
  const fixed = Math.max(0, Math.floor(input.fixedOverheadTokens));
  const estimated = Math.max(0, Math.floor(input.estimatedInputTokens));
  const configured = Math.max(MIN_COWORK_AUTO_THRESHOLD, Math.floor(input.configuredThreshold));
  const targetTokens = Math.max(fixed + 15_000, 35_000);
  const effectiveAutoThreshold = Math.max(
    configured,
    MIN_COWORK_AUTO_THRESHOLD,
    targetTokens + 25_000,
  );

  return {
    targetTokens,
    effectiveAutoThreshold,
    shouldAutoCompact: estimated >= effectiveAutoThreshold && estimated > targetTokens,
  };
}

export function resolveManualCompactionCommand(text: string): string | null {
  const firstLine = text
    .replace(/^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/iu, '')
    .split(/\r?\n/u, 1)[0]
    ?.trim();
  if (!firstLine) {
    return null;
  }

  return /^(?:(?:\.\\compact|\.\/compact\.?|\/compact)(?:\s+.*)?|\/compact\.)$/iu.test(firstLine)
    ? firstLine
    : null;
}

function operationKey(request: Pick<CompactionRequest, 'tenantId' | 'clientSessionId'>): string {
  return JSON.stringify([request.tenantId, request.clientSessionId]);
}

export class ContextCompactionCoordinator {
  private readonly operations = new Map<string, CompactionOperation>();
  private readonly confirmations = new Map<string, CompactionConfirmation>();
  private readonly protections = new Map<string, CompactionProtection>();
  private sequence = 0;

  public constructor(
    private readonly options: {
      now?: () => number;
      operationTtlMs?: number;
      confirmationTtlMs?: number;
      maxActiveOperations?: number;
      maxConfirmations?: number;
      maxProtections?: number;
    } = {},
  ) {}

  public acquire(request: CompactionRequest): AcquireResult {
    const now = request.now ?? this.now();
    this.cleanup(now);
    if (request.source !== 'cowork') {
      return { kind: 'rejected', reason: 'untrusted-source' };
    }
    if (request.estimatedInputTokens <= request.targetTokens) {
      return { kind: 'rejected', reason: 'below-target' };
    }

    const key = operationKey(request);
    const existing = this.operations.get(key);
    if (existing && existing.generation === request.generation && existing.expiresAt > now) {
      return { kind: 'reused', operation: { ...existing } };
    }
    const replaced = Number(existing !== undefined) + Number(this.protections.has(key));
    if (
      (!existing && this.operations.size >= this.maxActiveOperations()) ||
      this.operations.size + this.protections.size - replaced >=
        (this.options.maxProtections ?? DEFAULT_MAX_PROTECTIONS)
    ) {
      return { kind: 'rejected', reason: 'capacity' };
    }

    this.invalidate(request.tenantId, request.clientSessionId);

    const operation: CompactionOperation = {
      id: `compact_${now.toString(36)}_${(++this.sequence).toString(36)}`,
      key,
      tenantId: request.tenantId,
      clientSessionId: request.clientSessionId,
      generation: request.generation,
      mode: request.mode,
      source: request.source,
      beforeTokens: request.estimatedInputTokens,
      targetTokens: request.targetTokens,
      algorithmVersion: CONTEXT_COMPACTION_ALGORITHM_VERSION,
      inputFingerprint: request.inputFingerprint,
      ...(request.inputHistoryMessages !== undefined
        ? { inputHistoryMessages: request.inputHistoryMessages }
        : {}),
      ...(request.inputHistory ? { inputHistory: request.inputHistory } : {}),
      status: 'active',
      createdAt: now,
      expiresAt: now + this.operationTtlMs(),
    };
    this.operations.set(key, operation);
    return { kind: 'acquired', operation: { ...operation } };
  }

  public getOperation(tenantId: string, clientSessionId: string): CompactionOperation | null {
    this.cleanup(this.now());
    const operation = this.operations.get(operationKey({ tenantId, clientSessionId }));
    return operation ? { ...operation } : null;
  }

  public getProtection(tenantId: string, clientSessionId: string): CompactionProtection | null {
    this.cleanup(this.now());
    const protection = this.protections.get(operationKey({ tenantId, clientSessionId }));
    return protection ? { ...protection } : null;
  }

  public clear(): void {
    this.operations.clear();
    this.confirmations.clear();
    this.protections.clear();
  }

  public markSummaryInFlight(operationId: string, now = this.now()): CompactionOperation | null {
    this.cleanup(now);
    const operation = this.findById(operationId);
    if (!operation || operation.status !== 'active') {
      return null;
    }

    operation.status = 'summary-in-flight';
    return { ...operation };
  }

  public markProviderSummarySucceeded(
    input: ProviderSummarySuccessInput,
  ): CompactionOperation | null {
    const now = input.now ?? this.now();
    this.cleanup(now);
    const operation = this.findById(input.operationId);
    if (!operation || operation.status !== 'summary-in-flight' || !input.summaryFingerprint) {
      return null;
    }

    operation.providerSummaryFingerprint = input.summaryFingerprint;
    if (input.summaryCharacters !== undefined) {
      operation.providerSummaryCharacters = input.summaryCharacters;
    }
    if (input.retainedHistory) {
      operation.retainedHistory = input.retainedHistory;
    }
    delete operation.inputHistory;
    operation.status = 'summary-succeeded';
    return { ...operation };
  }

  public complete(input: CompletionInput): CompactionConfirmation | null {
    const now = input.now ?? this.now();
    this.cleanup(now);
    const operation = this.findById(input.operationId);
    if (
      !operation ||
      operation.status !== 'summary-succeeded' ||
      !operation.providerSummaryFingerprint
    ) {
      return null;
    }
    if (
      !input.newHistoryFingerprint ||
      input.newHistoryFingerprint === operation.inputFingerprint
    ) {
      return null;
    }

    operation.status = 'completed';
    const afterTokens = Math.max(0, Math.floor(input.newEstimatedInputTokens));
    const confirmation: CompactionConfirmation = {
      operationId: operation.id,
      historyFingerprint: input.newHistoryFingerprint,
      beforeTokens: operation.beforeTokens,
      afterTokens,
      savedEstimatedTokens: Math.max(0, operation.beforeTokens - afterTokens),
      createdAt: now,
      expiresAt: now + this.confirmationTtlMs(),
    };
    this.storeConfirmation(operation.key, confirmation);
    this.protections.set(operation.key, {
      tenantId: operation.tenantId,
      clientSessionId: operation.clientSessionId,
      generation: operation.generation,
      operationId: operation.id,
      adoptedHistoryFingerprint: input.newHistoryFingerprint,
      ...(input.newHistoryMessages !== undefined
        ? { adoptedHistoryMessages: input.newHistoryMessages }
        : {}),
      activated: false,
      expiresAt: now + PENDING_CONTINUATION_TTL_MS,
    });
    this.operations.delete(operation.key);
    return { ...confirmation };
  }

  public fail(operationId: string, now = this.now()): boolean {
    this.cleanup(now);
    const operation = this.findById(operationId);
    if (!operation) {
      return false;
    }

    this.operations.delete(operation.key);
    return true;
  }

  /** The trusted request owner supplies the operation/adopted-root proof, never a text tag. */
  public continue(input: CompactionContinuation, now = this.now()): CompactionProtection | null {
    this.cleanup(now);
    const protection = this.protections.get(operationKey(input));
    if (
      !protection ||
      protection.operationId !== input.operationId ||
      protection.generation !== input.generation ||
      protection.adoptedHistoryFingerprint !== input.adoptedHistoryFingerprint
    ) {
      return null;
    }
    protection.activated = true;
    protection.expiresAt = now + ACTIVE_CONTINUATION_TTL_MS;
    return { ...protection };
  }

  public invalidate(tenantId: string, clientSessionId: string): void {
    const key = operationKey({ tenantId, clientSessionId });
    this.operations.delete(key);
    this.protections.delete(key);
    for (const confirmationKey of this.confirmations.keys()) {
      if (confirmationKey.startsWith(`${key}\u0000`)) {
        this.confirmations.delete(confirmationKey);
      }
    }
  }

  public getConfirmation(
    tenantId: string,
    clientSessionId: string,
    operationId: string,
    historyFingerprint: string,
    now = this.now(),
  ): CompactionConfirmation | null {
    this.cleanup(now);
    const value = this.confirmations.get(
      `${operationKey({ tenantId, clientSessionId })}\u0000${operationId}\u0000${historyFingerprint}`,
    );
    return value ? { ...value } : null;
  }

  public snapshot(now = this.now()): {
    activeOperations: number;
    confirmations: number;
    protections: number;
  } {
    this.cleanup(now);
    return {
      activeOperations: this.operations.size,
      confirmations: this.confirmations.size,
      protections: this.protections.size,
    };
  }

  private storeConfirmation(key: string, confirmation: CompactionConfirmation): void {
    if (this.confirmations.size >= this.maxConfirmations()) {
      const oldest = this.confirmations.keys().next().value;
      if (oldest) {
        this.confirmations.delete(oldest);
      }
    }
    this.confirmations.set(
      `${key}\u0000${confirmation.operationId}\u0000${confirmation.historyFingerprint}`,
      confirmation,
    );
  }

  private findById(operationId: string): CompactionOperation | null {
    for (const operation of this.operations.values()) {
      if (operation.id === operationId) {
        return operation;
      }
    }
    return null;
  }

  private cleanup(now: number): void {
    for (const [key, operation] of this.operations) {
      if (operation.expiresAt <= now) {
        this.operations.delete(key);
      }
    }
    for (const [key, confirmation] of this.confirmations) {
      if (confirmation.expiresAt <= now) {
        this.confirmations.delete(key);
      }
    }
    for (const [key, protection] of this.protections) {
      if (protection.expiresAt <= now) {
        this.protections.delete(key);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private operationTtlMs(): number {
    return this.options.operationTtlMs ?? DEFAULT_COMPACTION_TTL_MS;
  }

  private confirmationTtlMs(): number {
    return this.options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  }

  private maxActiveOperations(): number {
    return this.options.maxActiveOperations ?? DEFAULT_MAX_ACTIVE_OPERATIONS;
  }

  private maxConfirmations(): number {
    return this.options.maxConfirmations ?? DEFAULT_MAX_CONFIRMATIONS;
  }
}
