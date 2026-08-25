import path from 'path';

import { Injectable, Optional } from '@nestjs/common';

import {
  isDurableStoreTestEnvironment,
  readPositiveIntegerEnv,
} from '@/shared/persistence/durable-store-settings';
import { getProxyStateDir } from '@/shared/platform/paths';
import {
  DEFAULT_OPENAI_RESPONSES_MAX_SESSIONS,
  DEFAULT_OPENAI_RESPONSES_SESSION_TTL_MS,
  OpenAIResponsesSessionStoreImpl,
  type OpenAIResponsesSessionStoreOptions,
} from './openai-responses-session.store';

export const OPENAI_RESPONSES_SESSION_FILENAME = 'openai-responses-sessions.json';

export function defaultOpenAIResponsesSessionStoreOptions(): OpenAIResponsesSessionStoreOptions {
  return {
    filePath: isDurableStoreTestEnvironment()
      ? undefined
      : path.join(getProxyStateDir(), OPENAI_RESPONSES_SESSION_FILENAME),
    maxSessions: readPositiveIntegerEnv(
      'AGM_RESPONSES_SESSION_MAX_ENTRIES',
      DEFAULT_OPENAI_RESPONSES_MAX_SESSIONS,
    ),
    ttlMs: readPositiveIntegerEnv(
      'AGM_RESPONSES_SESSION_TTL_MS',
      DEFAULT_OPENAI_RESPONSES_SESSION_TTL_MS,
    ),
  };
}

/**
 * The injectable, restart-surviving Responses session store.
 *
 * The class it extends stays transport-agnostic and defaults to memory only, so
 * ephemeral per-connection state can reuse it without touching the disk.
 */
@Injectable()
export class OpenAIResponsesSessionService extends OpenAIResponsesSessionStoreImpl {
  public constructor(@Optional() options?: OpenAIResponsesSessionStoreOptions) {
    super(options ?? defaultOpenAIResponsesSessionStoreOptions());
  }
}
