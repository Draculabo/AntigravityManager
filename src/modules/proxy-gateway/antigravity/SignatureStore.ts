/**
 * thought_signature storage for Gemini 3+ tool-call continuation.
 *
 * Clients that provide a stable session identifier are isolated from one another.
 * Requests without one preserve the legacy shared-signature behavior.
 */
import { logger } from '@/shared/logging/logger';

interface StoredSignature {
  signature: string;
  updatedAt: number;
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

  private signature: string | null = null;
  private readonly signaturesBySession = new Map<string, SessionSignatureBucket>();

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
   */
  public store(sig: string, sessionKey?: string, messageCount?: number): void {
    if (!sig) {
      return;
    }

    if (!sessionKey) {
      const existingLen = this.signature?.length ?? 0;
      if (sig.length > existingLen) {
        logger.info(
          `[ThoughtSig] Storing signature (length: ${sig.length}, replacing old: ${existingLen}, session: legacy)`,
        );
        this.signature = sig;
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
            `[ThoughtSig] Rewind detected (session: ${sessionKey}, current: ${normalizedMessageCount}, removed future: ${cachedMessageCount})`,
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

    if (newLen > existingLen) {
      logger.info(
        `[ThoughtSig] Storing signature (length: ${newLen}, replacing old: ${existingLen}, session: ${sessionKey}, message count: ${normalizedMessageCount ?? 'legacy'})`,
      );
      const stored = { signature: sig, updatedAt: now };
      if (normalizedMessageCount === undefined) {
        bucket.legacySignature = stored;
      } else {
        bucket.signaturesByMessageCount.set(normalizedMessageCount, stored);
      }
    } else {
      logger.debug(
        `[ThoughtSig] Skipping shorter signature (new length: ${newLen}, existing: ${existingLen}, session: ${sessionKey}, message count: ${normalizedMessageCount ?? 'legacy'})`,
      );
    }

    this.signaturesBySession.set(sessionKey, bucket);
    this.evictOverflowSessions();
  }

  /**
   * Get the stored thought_signature without clearing it.
   */
  public get(sessionKey?: string): string | null {
    if (sessionKey) {
      const stored = this.signaturesBySession.get(sessionKey);
      if (!stored) {
        return null;
      }
      if (Date.now() - stored.updatedAt >= SignatureStoreImpl.SESSION_TTL_MS) {
        this.signaturesBySession.delete(sessionKey);
        return null;
      }
      let latestMessageCount = -1;
      let latestSignature: string | null = null;
      for (const [messageCount, cached] of stored.signaturesByMessageCount) {
        if (messageCount > latestMessageCount) {
          latestMessageCount = messageCount;
          latestSignature = cached.signature;
        }
      }
      return latestSignature ?? stored.legacySignature?.signature ?? null;
    }
    return this.signature;
  }

  /**
   * Get the signature produced for the assistant message at an exact conversation index.
   */
  public getAt(sessionKey: string | undefined, messageCount: number): string | null {
    if (!sessionKey) {
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
    return stored.signaturesByMessageCount.get(messageCount)?.signature ?? null;
  }

  /**
   * Get and clear the stored thought_signature.
   */
  public take(sessionKey?: string): string | null {
    if (sessionKey) {
      const signature = this.get(sessionKey);
      this.signaturesBySession.delete(sessionKey);
      return signature;
    }
    const sig = this.signature;
    this.signature = null;
    return sig;
  }

  /**
   * Clear the stored thought_signature.
   */
  public clear(sessionKey?: string): void {
    if (sessionKey) {
      this.signaturesBySession.delete(sessionKey);
      return;
    }
    this.signature = null;
    this.signaturesBySession.clear();
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
