export const HOT_SIGNATURE_TTL_MS = 60 * 60 * 1000;
export const MAX_HOT_SIGNATURE_ASSOCIATIONS = 10_000;

export interface StoredSignature {
  thoughtSessionKey?: string;
  /** Null retains ambiguity until the original association expires or is evicted. */
  signature: string | null;
  /** First observed capture; these legacy mapper values have no proven completion time. */
  capturedAt: number;
  sourceModel: string;
  sourceFamily: string | null;
  messageCount?: number;
}
export interface StoredToolCallSignature extends StoredSignature {
  sessionKey: string;
  toolName?: string;
}
export interface SessionSignatureBucket {
  signaturesByMessageCount: Map<string, StoredSignature>;
  legacySignature?: StoredSignature;
  updatedAt: number;
}

export function signatureExpired(value: StoredSignature, now = Date.now()): boolean {
  return now - value.capturedAt >= HOT_SIGNATURE_TTL_MS;
}

/** Count actual retained associations, including aliases and ambiguity markers. */
export function pruneSignatureCache(
  sessions: Map<string, SessionSignatureBucket>,
  tools: Map<string, StoredToolCallSignature>,
  now = Date.now(),
): void {
  let count = 0;
  for (const [key, bucket] of sessions) {
    for (const [slot, value] of bucket.signaturesByMessageCount) {
      if (signatureExpired(value, now)) {
        bucket.signaturesByMessageCount.delete(slot);
      }
    }
    if (bucket.legacySignature && signatureExpired(bucket.legacySignature, now)) {
      bucket.legacySignature = undefined;
    }
    count += bucket.signaturesByMessageCount.size + Number(bucket.legacySignature !== undefined);
    if (!bucket.legacySignature && bucket.signaturesByMessageCount.size === 0) {
      sessions.delete(key);
    }
  }
  for (const [key, value] of tools) {
    if (signatureExpired(value, now)) {
      tools.delete(key);
    }
  }
  count += tools.size;
  // A store adds at most one message slot and one tool alias. Find the oldest
  // without sorting or keeping a second long-lived reverse index.
  while (count > MAX_HOT_SIGNATURE_ASSOCIATIONS) {
    let oldest = Number.POSITIVE_INFINITY;
    let remove: (() => void) | undefined;
    for (const [key, bucket] of sessions) {
      for (const [slot, value] of bucket.signaturesByMessageCount) {
        if (value.capturedAt < oldest) {
          oldest = value.capturedAt;
          remove = () => {
            bucket.signaturesByMessageCount.delete(slot);
            if (!bucket.legacySignature && bucket.signaturesByMessageCount.size === 0) {
              sessions.delete(key);
            }
          };
        }
      }
      if (bucket.legacySignature && bucket.legacySignature.capturedAt < oldest) {
        oldest = bucket.legacySignature.capturedAt;
        remove = () => {
          bucket.legacySignature = undefined;
          if (bucket.signaturesByMessageCount.size === 0) {
            sessions.delete(key);
          }
        };
      }
    }
    for (const [key, value] of tools) {
      if (value.capturedAt < oldest) {
        oldest = value.capturedAt;
        remove = () => {
          tools.delete(key);
        };
      }
    }
    if (!remove) {
      return;
    }
    remove();
    count -= 1;
  }
}

/** Match captured ownership, never infer a Thought client from an anchored protocol key. */
export function clearThoughtSignatureScope(
  sessions: Map<string, SessionSignatureBucket>,
  tools: Map<string, StoredToolCallSignature>,
  thoughtSessionKey?: string,
): { removed: number; unknown: number } {
  pruneSignatureCache(sessions, tools);
  let removed = 0;
  let unknown = 0;
  for (const [key, bucket] of sessions) {
    for (const [slot, value] of bucket.signaturesByMessageCount) {
      if (thoughtSessionKey === undefined || value.thoughtSessionKey === thoughtSessionKey) {
        bucket.signaturesByMessageCount.delete(slot);
        removed += 1;
      } else if (value.thoughtSessionKey === undefined) {
        unknown += 1;
      }
    }
    if (bucket.legacySignature) {
      if (
        thoughtSessionKey === undefined ||
        bucket.legacySignature.thoughtSessionKey === thoughtSessionKey
      ) {
        bucket.legacySignature = undefined;
        removed += 1;
      } else if (bucket.legacySignature.thoughtSessionKey === undefined) {
        unknown += 1;
      }
    }
    if (!bucket.legacySignature && bucket.signaturesByMessageCount.size === 0) {
      sessions.delete(key);
    }
  }
  for (const [key, value] of tools) {
    if (thoughtSessionKey === undefined || value.thoughtSessionKey === thoughtSessionKey) {
      tools.delete(key);
      removed += 1;
    } else if (value.thoughtSessionKey === undefined) {
      unknown += 1;
    }
  }
  return { removed, unknown };
}
