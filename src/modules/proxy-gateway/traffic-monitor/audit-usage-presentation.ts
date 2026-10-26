export type AuditCacheRatio =
  | { state: 'available'; ratio: number }
  | { state: 'missing' | 'zero-input' | 'inconsistent' };

/** Stored totals and cache details are independent; relative size cannot redefine input. */
export function auditCacheRatio(input: number | null, cached: number | null): AuditCacheRatio {
  if (input == null || cached == null) {
    return { state: 'missing' };
  }
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(cached) ||
    input < 0 ||
    cached < 0 ||
    cached > input
  ) {
    return { state: 'inconsistent' };
  }
  if (input === 0) {
    return { state: 'zero-input' };
  }
  return { state: 'available', ratio: cached / input };
}

export interface AuditStageTimings {
  clean: number | null;
  normalization: number | null;
  thinking: number | null;
  ttft: number | null;
}

/** Read only bounded persisted header metadata, never model body content. */
export function auditStageTimings(headers: string | null): AuditStageTimings {
  const missing: AuditStageTimings = {
    clean: null,
    normalization: null,
    thinking: null,
    ttft: null,
  };
  if (!headers || headers.length > 64 * 1024) {
    return missing;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(headers);
  } catch {
    return missing;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return missing;
  }
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      values.set(key.toLowerCase(), value);
    }
  }
  function read(name: string): number | null {
    const value = values.get(name);
    if (!value || !/^\d+(?:\.\d+)?$/u.test(value)) {
      return null;
    }
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    // Previous timing headers replaced unmeasured stages with zero; retain that ambiguity.
    return milliseconds === 0 && values.get('x-timing-version') !== '2' ? null : milliseconds;
  }
  return {
    clean: read('x-timing-clean-ms'),
    normalization: read('x-timing-norm-ms'),
    thinking: read('x-timing-thinking-ms'),
    ttft: read('x-timing-ttft-ms'),
  };
}
