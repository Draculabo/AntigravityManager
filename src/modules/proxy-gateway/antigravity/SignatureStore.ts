/**
 * thought_signature storage for Gemini 3+ tool-call continuation.
 *
 * Cache reads and writes require a conversation scope. Unscoped requests are misses.
 *
 * Entries are additionally indexed by session and tool-call id. Tool-call ids are
 * only unique inside a conversation, so indexing them globally would allow one
 * client's signature to overwrite another client's entry.
 */
import { logger } from '@/shared/logging/logger';
import { getTrafficAuditRequestContext } from '../audit/traffic-audit-context';
import { registerThoughtRecoveryPeer } from '../thought-store/thought-recovery-peers';
import { isThoughtSignaturePlaceholder } from './ThoughtSignatureCompat';
import { areThoughtSignaturesEquivalent } from './thought-signature-format';
import {
  areThoughtSignatureModelsCompatible,
  normalizeThoughtSignatureModelContext,
  type NormalizedThoughtSignatureModelContext,
  type ThoughtSignatureModelContext,
} from './thought-signature-model';

import {
  clearThoughtSignatureScope,
  pruneSignatureCache,
  signatureExpired,
  type StoredSignature,
  type StoredToolCallSignature,
  type SessionSignatureBucket,
} from './signature-cache-retention';

class SignatureStoreImpl {
  private static instance: SignatureStoreImpl;
  private static readonly MAX_SESSION_ENTRIES = 500;
  private static readonly SESSION_TTL_MS = 60 * 60 * 1000;

  private readonly signaturesBySession = new Map<string, SessionSignatureBucket>();
  private readonly signaturesByToolCallKey = new Map<string, StoredToolCallSignature>();

  private constructor() {}

  public static getInstance(): SignatureStoreImpl {
    if (!SignatureStoreImpl.instance) {
      SignatureStoreImpl.instance = new SignatureStoreImpl();
    }
    return SignatureStoreImpl.instance;
  }

  /**
   * Stores one opaque value per scope. Conflicting values invalidate recovery rather
   * than guessing whether one is a streaming fragment or a different response.
   * A supplied tool-call id additionally makes the signature retrievable within
   * the same session via {@link getForToolCall}.
   */
  public store(
    options: ThoughtSignatureModelContext & {
      signature: string;
      sessionKey?: string;
      messageCount?: number;
      toolCallId?: string;
      toolName?: string;
    },
  ): void {
    if (getTrafficAuditRequestContext()?.thoughtCaptureLease?.valid === false) {
      return;
    }
    const { signature: sig, sessionKey, messageCount, toolCallId } = options;
    const source = normalizeThoughtSignatureModelContext(options);
    if (!sig || isThoughtSignaturePlaceholder(sig) || !source || !sessionKey?.trim()) {
      return;
    }

    pruneSignatureCache(this.signaturesBySession, this.signaturesByToolCallKey);
    if (toolCallId) {
      this.storeByToolCallId(sig, source, toolCallId, sessionKey, options.toolName);
    }

    this.evictExpiredSessions();
    const now = Date.now();
    const bucket = this.signaturesBySession.get(sessionKey) ?? {
      signaturesByMessageCount: new Map<string, StoredSignature>(),
      updatedAt: now,
    };
    bucket.updatedAt = now;

    const normalizedMessageCount =
      Number.isInteger(messageCount) && (messageCount ?? -1) >= 0 ? messageCount : undefined;

    if (normalizedMessageCount !== undefined) {
      for (const [key, cached] of bucket.signaturesByMessageCount) {
        if (
          cached.messageCount !== undefined &&
          cached.messageCount > normalizedMessageCount &&
          this.hasSameSource(cached, source)
        ) {
          bucket.signaturesByMessageCount.delete(key);
          logger.info(
            `[ThoughtSig] Rewind detected (session: scoped, current: ${normalizedMessageCount}, removed future: ${cached.messageCount})`,
          );
        }
      }
    }

    const messageKey =
      normalizedMessageCount === undefined
        ? undefined
        : this.createSessionSlotKey(normalizedMessageCount, source);
    const existingStored =
      messageKey === undefined
        ? bucket.legacySignature
        : bucket.signaturesByMessageCount.get(messageKey);
    const stored = this.mergeStoredSignature(
      existingStored,
      sig,
      source,
      now,
      normalizedMessageCount,
    );
    if (messageKey === undefined) {
      bucket.legacySignature = stored;
    } else {
      bucket.signaturesByMessageCount.set(messageKey, stored);
    }

    this.touchSession(sessionKey, bucket, now);
    this.evictOverflowSessions();
    pruneSignatureCache(this.signaturesBySession, this.signaturesByToolCallKey, now);
  }

  /**
   * Get the stored thought_signature without clearing it.
   */
  public get(options: ThoughtSignatureModelContext & { sessionKey?: string }): string | null {
    if (getTrafficAuditRequestContext()?.thoughtCaptureLease?.valid === false) {
      return null;
    }
    const target = normalizeThoughtSignatureModelContext(options);
    if (!target) {
      return null;
    }
    const { sessionKey } = options;
    if (sessionKey) {
      const stored = this.signaturesBySession.get(sessionKey);
      if (!stored) {
        return null;
      }
      if (Date.now() - stored.updatedAt >= SignatureStoreImpl.SESSION_TTL_MS) {
        this.signaturesBySession.delete(sessionKey);
        return null;
      }
      this.touchSession(sessionKey, stored);
      let latestMessageCount = -1;
      let latestSignature: string | null = null;
      for (const cached of stored.signaturesByMessageCount.values()) {
        const messageCount = cached.messageCount ?? -1;
        if (
          !signatureExpired(cached) &&
          this.hasSameSource(cached, target) &&
          messageCount > latestMessageCount
        ) {
          latestMessageCount = messageCount;
          latestSignature = cached.signature;
        }
      }
      return latestMessageCount >= 0
        ? latestSignature
        : this.readCompatibleSignature(stored.legacySignature, target);
    }
    return null;
  }

  /**
   * Get the signature stored for a specific tool-call id in the given session.
   * A miss (no entry, or an expired one) returns null; it is a normal outcome, not an error.
   */
  public getForToolCall(
    options: ThoughtSignatureModelContext & {
      toolCallId: string | undefined;
      sessionKey?: string;
      toolName?: string;
    },
  ): string | null {
    if (getTrafficAuditRequestContext()?.thoughtCaptureLease?.valid === false) {
      return null;
    }
    const { toolCallId, sessionKey } = options;
    if (!toolCallId || !sessionKey?.trim()) {
      return null;
    }
    const target = normalizeThoughtSignatureModelContext(options);
    if (!target) {
      return null;
    }
    const toolCallKey = this.createToolCallKey(toolCallId, sessionKey, target);
    const stored = this.signaturesByToolCallKey.get(toolCallKey);
    if (!stored || (options.toolName !== undefined && stored.toolName !== options.toolName)) {
      return null;
    }
    if (signatureExpired(stored)) {
      this.signaturesByToolCallKey.delete(toolCallKey);
      return null;
    }
    this.touchToolCallEntry(toolCallKey, stored);
    return this.readCompatibleSignature(stored, target);
  }

  /**
   * Get the signature produced for the assistant message at an exact conversation index.
   */
  public getAt(
    options: ThoughtSignatureModelContext & {
      sessionKey: string | undefined;
      messageCount: number;
    },
  ): string | null {
    if (getTrafficAuditRequestContext()?.thoughtCaptureLease?.valid === false) {
      return null;
    }
    const { sessionKey, messageCount } = options;
    if (!sessionKey) {
      return null;
    }
    const target = normalizeThoughtSignatureModelContext(options);
    if (!target) {
      return null;
    }
    const stored = this.signaturesBySession.get(sessionKey);
    if (!stored) {
      return null;
    }
    if (Date.now() - stored.updatedAt >= SignatureStoreImpl.SESSION_TTL_MS) {
      this.signaturesBySession.delete(sessionKey);
      return null;
    }
    this.touchSession(sessionKey, stored);
    return this.readCompatibleSignature(
      stored.signaturesByMessageCount.get(this.createSessionSlotKey(messageCount, target)),
      target,
    );
  }

  /**
   * Get and clear the stored thought_signature.
   */
  public take(options: ThoughtSignatureModelContext & { sessionKey?: string }): string | null {
    const { sessionKey } = options;
    if (sessionKey) {
      const signature = this.get(options);
      this.clear(sessionKey);
      return signature;
    }
    return null;
  }

  /**
   * Clear the stored thought_signature.
   */
  public clear(sessionKey?: string): void {
    if (sessionKey) {
      this.signaturesBySession.delete(sessionKey);
      for (const [toolCallKey, stored] of this.signaturesByToolCallKey) {
        if (stored.sessionKey === sessionKey) {
          this.signaturesByToolCallKey.delete(toolCallKey);
        }
      }
      return;
    }
    this.signaturesBySession.clear();
    this.signaturesByToolCallKey.clear();
  }

  /** Clears only the cache scope that could have contributed to one failed request. */
  public clearRecoveryScope(sessionKey?: string): void {
    if (sessionKey) {
      this.clear(sessionKey);
      return;
    }
  }

  /** Thought identity is retained at capture; it is never guessed from a protocol cache key. */
  public clearThoughtSession(thoughtSessionKey?: string): { removed: number; unknown: number } {
    return clearThoughtSignatureScope(
      this.signaturesBySession,
      this.signaturesByToolCallKey,
      thoughtSessionKey,
    );
  }

  private storeByToolCallId(
    sig: string,
    source: NormalizedThoughtSignatureModelContext,
    toolCallId: string,
    sessionKey: string,
    toolName?: string,
  ): void {
    const toolCallKey = this.createToolCallKey(toolCallId, sessionKey, source);
    const existing = this.signaturesByToolCallKey.get(toolCallKey);
    const stored = this.mergeStoredSignature(existing, sig, source);
    this.touchToolCallEntry(toolCallKey, {
      ...stored,
      sessionKey,
      toolName,
      signature: existing && existing.toolName !== toolName ? null : stored.signature,
    });
  }

  private mergeStoredSignature(
    existing: StoredSignature | undefined,
    signature: string,
    source: NormalizedThoughtSignatureModelContext,
    updatedAt = Date.now(),
    messageCount?: number,
  ): StoredSignature {
    if (!existing || !this.hasSameSource(existing, source)) {
      return this.createStoredSignature(signature, source, updatedAt, messageCount);
    }
    if (
      existing.signature !== null &&
      areThoughtSignaturesEquivalent(existing.signature, signature)
    ) {
      return {
        ...existing,
        thoughtSessionKey:
          getTrafficAuditRequestContext()?.thoughtSessionKey ?? existing.thoughtSessionKey,
      };
    }
    if (existing.signature !== null) {
      logger.warn('[ThoughtSig] Conflicting scoped signatures; automatic recovery disabled');
    }
    return {
      ...existing,
      signature: null,
      thoughtSessionKey:
        getTrafficAuditRequestContext()?.thoughtSessionKey ?? existing.thoughtSessionKey,
    };
  }

  private createStoredSignature(
    signature: string,
    source: NormalizedThoughtSignatureModelContext,
    updatedAt = Date.now(),
    messageCount?: number,
  ): StoredSignature {
    return {
      signature,
      thoughtSessionKey: getTrafficAuditRequestContext()?.thoughtSessionKey,
      capturedAt: updatedAt,
      sourceModel: source.model,
      sourceFamily: source.family,
      ...(messageCount !== undefined ? { messageCount } : {}),
    };
  }

  private hasSameSource(
    stored: StoredSignature,
    source: NormalizedThoughtSignatureModelContext,
  ): boolean {
    return areThoughtSignatureModelsCompatible(
      { model: stored.sourceModel, family: stored.sourceFamily },
      source,
    );
  }

  private readCompatibleSignature(
    stored: StoredSignature | undefined | null,
    target: NormalizedThoughtSignatureModelContext,
  ): string | null {
    if (!stored || signatureExpired(stored)) {
      return null;
    }
    return areThoughtSignatureModelsCompatible(
      { model: stored.sourceModel, family: stored.sourceFamily },
      target,
    )
      ? stored.signature
      : null;
  }

  private createToolCallKey(
    toolCallId: string,
    sessionKey: string,
    source: NormalizedThoughtSignatureModelContext,
  ): string {
    return JSON.stringify([
      sessionKey,
      toolCallId,
      source.family,
      source.family ? null : source.model,
    ]);
  }

  private createSessionSlotKey(
    messageCount: number,
    source: NormalizedThoughtSignatureModelContext,
  ): string {
    return JSON.stringify([source.family, source.family ? null : source.model, messageCount]);
  }

  private touchToolCallEntry(toolCallKey: string, stored: StoredToolCallSignature): void {
    this.signaturesByToolCallKey.delete(toolCallKey);
    this.signaturesByToolCallKey.set(toolCallKey, stored);
  }

  private touchSession(
    sessionKey: string,
    stored: SessionSignatureBucket,
    updatedAt = Date.now(),
  ): void {
    stored.updatedAt = updatedAt;
    this.signaturesBySession.delete(sessionKey);
    this.signaturesBySession.set(sessionKey, stored);
  }

  private evictExpiredSessions(): void {
    const oldestAllowed = Date.now() - SignatureStoreImpl.SESSION_TTL_MS;
    for (const [sessionKey, stored] of this.signaturesBySession.entries()) {
      if (stored.updatedAt <= oldestAllowed) {
        this.signaturesBySession.delete(sessionKey);
      }
    }
  }

  private evictOverflowSessions(): void {
    while (this.signaturesBySession.size > SignatureStoreImpl.MAX_SESSION_ENTRIES) {
      const oldestSessionKey = this.signaturesBySession.keys().next().value;
      if (!oldestSessionKey) {
        return;
      }
      this.signaturesBySession.delete(oldestSessionKey);
    }
  }
}

export const SignatureStore = SignatureStoreImpl.getInstance();
registerThoughtRecoveryPeer('signature-cache', async (key) =>
  SignatureStore.clearThoughtSession(key),
);
