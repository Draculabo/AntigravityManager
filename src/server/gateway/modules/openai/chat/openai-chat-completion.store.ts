import { DurableRecordStore } from '@/shared/persistence/durable-record-store';
import type { OpenAIChatResponse } from '../../../common/interfaces/request-interfaces';

export interface OpenAIChatCompletionStoreLike {
  clear(): void;
  delete(completionId: string): boolean;
  get(completionId: string): OpenAIChatResponse | null;
  save(completion: OpenAIChatResponse): void;
}

export interface OpenAIChatCompletionStoreOptions {
  /** Absolute path of the backing file. Omit to keep the store in memory only. */
  filePath?: string;
  maxCompletions?: number;
  ttlMs?: number;
}

export const DEFAULT_OPENAI_STORED_COMPLETION_MAX_ENTRIES = 500;
export const DEFAULT_OPENAI_STORED_COMPLETION_TTL_MS = 60 * 60 * 1000;

/**
 * Chat Completions a client asked this gateway to keep with `store: true`.
 *
 * It is a replay buffer, not a provider cache: it holds the answer this gateway
 * already produced so a client that lost the connection can read it back, and
 * it saves no tokens and shares nothing between machines.
 *
 * It is deliberately its own store rather than a corner of the Responses
 * session store. The two have unrelated lifetimes and unrelated volumes, and a
 * shared entry ceiling would let a burst of stored completions evict live
 * conversation state.
 */
export class OpenAIChatCompletionStoreImpl implements OpenAIChatCompletionStoreLike {
  private readonly completions: DurableRecordStore<OpenAIChatResponse>;

  public constructor(options: OpenAIChatCompletionStoreOptions = {}) {
    this.completions = new DurableRecordStore<OpenAIChatResponse>({
      filePath: options.filePath,
      maxEntries: options.maxCompletions ?? DEFAULT_OPENAI_STORED_COMPLETION_MAX_ENTRIES,
      ttlMs: options.ttlMs ?? DEFAULT_OPENAI_STORED_COMPLETION_TTL_MS,
      revive: reviveStoredChatCompletion,
    });
  }

  public get(completionId: string): OpenAIChatResponse | null {
    return this.completions.get(completionId);
  }

  public save(completion: OpenAIChatResponse): void {
    if (!completion?.id) {
      return;
    }
    this.completions.set(completion.id, completion);
  }

  public delete(completionId: string): boolean {
    return this.completions.delete(completionId);
  }

  public clear(): void {
    this.completions.clear();
  }

  /** Resolves once every pending write has reached the disk. */
  public flush(): Promise<void> {
    return this.completions.flush();
  }
}

/**
 * The process-wide in-memory store.
 *
 * It is the fallback for callers assembled outside Nest; the injectable
 * `OpenAIChatCompletionService` is the one that owns a file.
 */
export const OpenAIChatCompletionStore = new OpenAIChatCompletionStoreImpl();

/**
 * Accepts a completion read back from disk only when it still looks like the
 * object a client would be handed, so a hand-edited file costs that entry
 * rather than turning into a malformed reply.
 */
function reviveStoredChatCompletion(value: unknown): OpenAIChatResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const id = Reflect.get(value, 'id');
  const choices = Reflect.get(value, 'choices');
  if (typeof id !== 'string' || !id || !Array.isArray(choices)) {
    return null;
  }
  return value as OpenAIChatResponse;
}
