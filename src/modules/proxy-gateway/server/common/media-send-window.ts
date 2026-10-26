import type { ImageSchedulerConfig } from '@/modules/config/types';

/**
 * One protocol-recognized image position, in send order.
 *
 * Remote images have no measurable decoded size, so `bytes` is only meaningful
 * for inline candidates. The planner never downloads a remote URL to measure it.
 */
export interface MediaWindowCandidate {
  inline: boolean;
  bytes: number;
  /** Images introduced by the current operation are never trimmed by count. */
  protected: boolean;
}

export interface MediaWindowPlan {
  /** Candidate indexes whose media must not be sent, as an omission marker. */
  omitted: ReadonlySet<number>;
  protectedBytes: number;
  selectedBytes: number;
}

export const MEDIA_WINDOW_OMISSION_TEXT =
  '[image omitted from this request by the configured history media window]';

export class MediaWindowLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MediaWindowLimitError';
  }
}

function resolveOptions(config: ImageSchedulerConfig | undefined): {
  enabled: boolean;
  count: number;
  memoryBytes: number;
  stripRemoteUrls: boolean;
} {
  return {
    enabled: config?.send_window_enabled === true,
    count: config?.send_window_count ?? 10,
    memoryBytes: (config?.send_window_memory_mib ?? 32) * 1024 * 1024,
    stripRemoteUrls: config?.send_window_strip_remote_urls === true,
  };
}

/**
 * Selects which recognized image positions may be sent for one request.
 *
 * The window is opt-in and disabled by default. Count selects the newest
 * historical inline images, memory keeps a newest-first suffix by exact decoded
 * file bytes, and both never cross the independent admission limits. Omission is
 * idempotent because a replaced slot is no longer a recognized media record.
 */
export function planMediaSendWindow(
  candidates: readonly MediaWindowCandidate[],
  config: ImageSchedulerConfig | undefined,
): MediaWindowPlan {
  const options = resolveOptions(config);
  const omitted = new Set<number>();
  if (!options.enabled) {
    return { omitted, protectedBytes: 0, selectedBytes: 0 };
  }

  const protectedBytes = candidates.reduce(
    (total, candidate) => total + (candidate.protected && candidate.inline ? candidate.bytes : 0),
    0,
  );
  if (protectedBytes > options.memoryBytes) {
    throw new MediaWindowLimitError(
      `Current request images exceed the configured send window memory of ${options.memoryBytes} bytes`,
    );
  }

  const inline = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry) => entry.candidate.inline);

  const selected = new Set<number>();
  if (options.count === 0) {
    inline.forEach((entry) => selected.add(entry.index));
  } else {
    inline
      .filter((entry) => !entry.candidate.protected)
      .slice(-options.count)
      .forEach((entry) => selected.add(entry.index));
  }
  candidates.forEach((candidate, index) => {
    if (candidate.protected) {
      selected.add(index);
    }
  });

  let selectedBytes = inline.reduce(
    (total, entry) => total + (selected.has(entry.index) ? entry.candidate.bytes : 0),
    0,
  );
  for (const entry of inline) {
    if (selectedBytes <= options.memoryBytes) {
      break;
    }
    if (entry.candidate.protected || !selected.has(entry.index)) {
      continue;
    }
    selected.delete(entry.index);
    selectedBytes -= entry.candidate.bytes;
  }

  candidates.forEach((candidate, index) => {
    const omitInline = candidate.inline && !selected.has(index);
    if (omitInline || (!candidate.inline && options.stripRemoteUrls)) {
      omitted.add(index);
    }
  });

  return { omitted, protectedBytes, selectedBytes };
}
