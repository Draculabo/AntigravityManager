/**
 * thought_signature storage for Gemini 3+ tool-call continuation.
 *
 * Clients that provide a stable session identifier are isolated from one another.
 * Requests without one preserve the legacy shared-signature behavior.
 *
 * Entries are additionally indexed by session and tool-call id. Tool-call ids are
 * only unique inside a conversation, so indexing them globally would allow one
 * client's signature to overwrite another client's entry.
 */
import { logger } from '@/shared/logging/logger';
import {
  areThoughtSignatureModelsCompatible,
  normalizeThoughtSignatureModelContext,
  type NormalizedThoughtSignatureModelContext,
  type ThoughtSignatureModelContext,
} from './thought-signature-model';

interface StoredSignature {
  signature: string;
  updatedAt: number;
  sourceModel: string;
  sourceFamily: string | null;
}

interface StoredToolCallSignature extends StoredSignature {
  sessionKey?: string;
}

interface SessionSignatureBucket {
  signaturesByMessageCount: Map<number, StoredSignature>;
  legacySignature?: StoredSignature;
  updatedAt: number;
}

class SignatureStoreImpl {
  private static instance: SignatureStoreImpl;
  private static readonly MAX_SESSION_ENTRIES = 500;
  private static readonly SESSION_TTL_MS = 60 * 60 * 1000;

  private signature: StoredSignature | null = null;
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
   * Stores a signature, preferring the longest value because streaming chunks can
   * contain partial signatures. A supplied session key prevents cross-session reuse.
   * A supplied tool-call id additionally makes the signature retrievable within
   * the same session via {@link getForToolCall}.
   */
  public store(
    options: ThoughtSignatureModelContext & {
      signature: string;
      sessionKey?: string;
      messageCount?: number;
      toolCallId?: string;
    },
  ): void {
    const { signature: sig, sessionKey, messageCount, toolCallId } = options;
    const source = normalizeThoughtSignatureModelContext(options);
    if (!sig || !source) {
      return;
    }

    if (toolCallId) {
      this.storeByToolCallId(sig, source, toolCallId, sessionKey);
    }

    if (!sessionKey) {
      const existingLen = this.signature?.signature.length ?? 0;
      const sameSource = this.signature ? this.hasSameSource(this.signature, source) : true;
      if (!sameSource || sig.length > existingLen) {
        logger.info(
          `[ThoughtSig] Storing signature (length: ${sig.length}, replacing old: ${existingLen}, session: legacy)`,
        );
        this.signature = this.createStoredSignature(sig, source);
      } else {
        logger.debug(
          `[ThoughtSig] Skipping shorter signature (new length: ${sig.length}, existing: ${existingLen}, session: legacy)`,
        );
      }
      return;
    }

    this.evictExpiredSessions();
    const now = Date.now();
    const bucket = this.signaturesBySession.get(sessionKey) ?? {
      signaturesByMessageCount: new Map<number, StoredSignature>(),
      updatedAt: now,
    };
    bucket.updatedAt = now;

    const normalizedMessageCount =
      Number.isInteger(messageCount) && (messageCount ?? -1) >= 0 ? messageCount : undefined;

    if (normalizedMessageCount !== undefined) {
      for (const cachedMessageCount of bucket.signaturesByMessageCount.keys()) {
        if (cachedMessageCount > normalizedMessageCount) {
          bucket.signaturesByMessageCount.delete(cachedMessageCount);
          logger.info(
            `[ThoughtSig] Rewind detected (session: scoped, current: ${normalizedMessageCount}, removed future: ${cachedMessageCount})`,
          );
        }
      }
    }

    const existing =
      normalizedMessageCount === undefined
        ? bucket.legacySignature?.signature
        : bucket.signaturesByMessageCount.get(normalizedMessageCount)?.signature;
    const existingLen = existing ? existing.length : 0;
    const newLen = sig.length;
    const existingStored =
      normalizedMessageCount === undefined
        ? bucket.legacySignature
        : bucket.signaturesByMessageCount.get(normalizedMessageCount);
    const sameSource = existingStored ? this.hasSameSource(existingStored, source) : true;

    if (!sameSource || newLen > existingLen) {
      logger.info(
        `[ThoughtSig] Storing signature (length: ${newLen}, replacing old: ${existingLen}, session: scoped, message count: ${normalizedMessageCount ?? 'legacy'})`,
      );
      const stored = this.createStoredSignature(sig, source, now);
      if (normalizedMessageCount === undefined) {
        bucket.legacySignature = stored;
      } else {
        bucket.signaturesByMessageCount.set(normalizedMessageCount, stored);
      }
    } else {
      logger.debug(
        `[ThoughtSig] Skipping shorter signature (new length: ${newLen}, existing: ${existingLen}, session: scoped, message count: ${normalizedMessageCount ?? 'legacy'})`,
      );
    }

    this.touchSession(sessionKey, bucket, now);
    this.evictOverflowSessions();
  }

  /**
   * Get the stored thought_signature without clearing it.
   */
  public get(options: ThoughtSignatureModelContext & { sessionKey?: string }): string | null {
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
      for (const [messageCount, cached] of stored.signaturesByMessageCount) {
        const compatible = this.readCompatibleSignature(cached, target);
        if (compatible && messageCount > latestMessageCount) {
          latestMessageCount = messageCount;
          latestSignature = compatible;
        }
      }
      return latestSignature ?? this.readCompatibleSignature(stored.legacySignature, target);
    }
    return this.readCompatibleSignature(this.signature, target);
  }

  /**
   * Get the signature stored for a specific tool-call id in the given session.
   * A miss (no entry, or an expired one) returns null; it is a normal outcome, not an error.
   */
  public getForToolCall(
    options: ThoughtSignatureModelContext & { toolCallId: string | undefined; sessionKey?: string },
  ): string | null {
    const { toolCallId, sessionKey } = options;
    if (!toolCallId) {
      return null;
    }
    const target = normalizeThoughtSignatureModelContext(options);
    if (!target) {
      return null;
    }
    const toolCallKey = this.createToolCallKey(toolCallId, sessionKey);
    const stored = this.signaturesByToolCallKey.get(toolCallKey);
    if (!stored) {
      return null;
    }
    if (Date.now() - stored.updatedAt >= SignatureStoreImpl.SESSION_TTL_MS) {
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
    return this.readCompatibleSignature(stored.signaturesByMessageCount.get(messageCount), target);
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
    const sig = this.get(options);
    this.signature = null;
    return sig;
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
    this.signature = null;
    this.signaturesBySession.clear();
    this.signaturesByToolCallKey.clear();
  }

  /** Clears only the cache scope that could have contributed to one failed request. */
  public clearRecoveryScope(sessionKey?: string): void {
    if (sessionKey) {
      this.clear(sessionKey);
      return;
    }

    this.signature = null;
    for (const [toolCallKey, stored] of this.signaturesByToolCallKey) {
      if (!stored.sessionKey) {
        this.signaturesByToolCallKey.delete(toolCallKey);
      }
    }
  }

  private storeByToolCallId(
    sig: string,
    source: NormalizedThoughtSignatureModelContext,
    toolCallId: string,
    sessionKey?: string,
  ): void {
    this.evictExpiredToolCallEntries();
    const toolCallKey = this.createToolCallKey(toolCallId, sessionKey);
    const existing = this.signaturesByToolCallKey.get(toolCallKey);
    const existingLen = existing?.signature.length ?? 0;
    const sameSource = existing ? this.hasSameSource(existing, source) : true;
    if (!sameSource || sig.length > existingLen) {
      this.touchToolCallEntry(toolCallKey, {
        sessionKey,
        ...this.createStoredSignature(sig, source),
      });
    } else if (existing) {
      this.touchToolCallEntry(toolCallKey, existing);
    }
    this.evictOverflowToolCallEntries();
  }

  private createStoredSignature(
    signature: string,
    source: NormalizedThoughtSignatureModelContext,
    updatedAt = Date.now(),
  ): StoredSignature {
    return {
      signature,
      updatedAt,
      sourceModel: source.model,
      sourceFamily: source.family,
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
    if (!stored) {
      return null;
    }
    return areThoughtSignatureModelsCompatible(
      { model: stored.sourceModel, family: stored.sourceFamily },
      target,
    )
      ? stored.signature
      : null;
  }

  private createToolCallKey(toolCallId: string, sessionKey?: string): string {
    return JSON.stringify([sessionKey ?? null, toolCallId]);
  }

  private touchToolCallEntry(toolCallKey: string, stored: StoredToolCallSignature): void {
    stored.updatedAt = Date.now();
    this.signaturesByToolCallKey.delete(toolCallKey);
    this.signaturesByToolCallKey.set(toolCallKey, stored);
  }

  private evictExpiredToolCallEntries(): void {
    const oldestAllowed = Date.now() - SignatureStoreImpl.SESSION_TTL_MS;
    for (const [toolCallKey, stored] of this.signaturesByToolCallKey.entries()) {
      if (stored.updatedAt < oldestAllowed) {
        this.signaturesByToolCallKey.delete(toolCallKey);
      }
    }
  }

  private evictOverflowToolCallEntries(): void {
    while (this.signaturesByToolCallKey.size > SignatureStoreImpl.MAX_SESSION_ENTRIES) {
      const oldestToolCallKey = this.signaturesByToolCallKey.keys().next().value;
      if (!oldestToolCallKey) {
        return;
      }
      this.signaturesByToolCallKey.delete(oldestToolCallKey);
    }
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
      if (stored.updatedAt < oldestAllowed) {
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
