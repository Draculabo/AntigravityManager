import path from 'path';

import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  isDurableStoreTestEnvironment,
  readPositiveIntegerEnv,
} from '@/shared/persistence/durable-store-settings';
import { getProxyStateDir } from '@/shared/platform/paths';
import {
  DEFAULT_OPENAI_STORED_COMPLETION_MAX_ENTRIES,
  DEFAULT_OPENAI_STORED_COMPLETION_TTL_MS,
  OpenAIChatCompletionStoreImpl,
  type OpenAIChatCompletionStoreOptions,
} from './openai-chat-completion.store';

export const OPENAI_CHAT_COMPLETION_STORE_OPTIONS = 'OPENAI_CHAT_COMPLETION_STORE_OPTIONS';
export const OPENAI_CHAT_COMPLETION_FILENAME = 'openai-chat-completions.json';

export function defaultOpenAIChatCompletionStoreOptions(): OpenAIChatCompletionStoreOptions {
  return {
    filePath: isDurableStoreTestEnvironment()
      ? undefined
      : path.join(getProxyStateDir(), OPENAI_CHAT_COMPLETION_FILENAME),
    maxCompletions: readPositiveIntegerEnv(
      'AGM_STORED_COMPLETION_MAX_ENTRIES',
      DEFAULT_OPENAI_STORED_COMPLETION_MAX_ENTRIES,
    ),
    ttlMs: readPositiveIntegerEnv(
      'AGM_STORED_COMPLETION_TTL_MS',
      DEFAULT_OPENAI_STORED_COMPLETION_TTL_MS,
    ),
  };
}

/** The injectable, restart-surviving store behind `store: true`. */
@Injectable()
export class OpenAIChatCompletionService extends OpenAIChatCompletionStoreImpl {
  public constructor(
    @Optional()
    @Inject(OPENAI_CHAT_COMPLETION_STORE_OPTIONS)
    options?: OpenAIChatCompletionStoreOptions,
  ) {
    super(options ?? defaultOpenAIChatCompletionStoreOptions());
  }
}
