import path from 'path';
import { tmpdir } from 'node:os';

import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  isDurableStoreTestEnvironment,
  readPositiveIntegerEnv,
} from '@/shared/persistence/durable-store-settings';
import { getProxyStateDir } from '@/shared/platform/paths';
import { FilesService, type PrivateContentStoreOptions } from '../../files/files.service';
import { OpenAIResponsesMediaStore } from './openai-responses-media-store';
import { registerThoughtRecoveryPeer } from '../../../../../modules/proxy-gateway/thought-store/thought-recovery-peers';
import { deleteResponsesRecoveryScope } from './responses-thought-recovery';
import {
  DEFAULT_OPENAI_RESPONSES_MAX_SESSIONS,
  DEFAULT_OPENAI_RESPONSES_SESSION_TTL_MS,
  OpenAIResponsesSessionStoreImpl,
  type OpenAIResponsesSessionStoreOptions,
} from './openai-responses-session.store';

// Reuse the existing path; strict decoding drops records without the new identity metadata.
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
  private releaseThoughtPeer?: () => void;
  private processOwned = false;
  public constructor(
    @Optional() options?: OpenAIResponsesSessionStoreOptions,
    @Optional() @Inject(FilesService) files?: FilesService,
  ) {
    super(withPrivateMediaStore(options ?? defaultOpenAIResponsesSessionStoreOptions(), files));
  }
  public onModuleInit(): void {
    if (this.processOwned) {
      return;
    }
    this.releaseThoughtPeer = registerThoughtRecoveryPeer('responses', (key) =>
      deleteResponsesRecoveryScope(key, (scope) => this.deleteThoughtSession(scope)),
    );
  }
  public override onModuleDestroy(): void {
    if (!this.processOwned) {
      this.releaseThoughtPeer?.();
    }
    super.onModuleDestroy();
  }

  /** The selected process owner, rather than a transient Nest module, holds recovery admission. */
  public retainForProcess(): void {
    this.processOwned = true;
  }

  public attachFiles(files: FilesService): void {
    const media = withPrivateMediaStore({}, files).mediaStore;
    this.replaceMediaStore(media);
  }
}

function withPrivateMediaStore(
  options: OpenAIResponsesSessionStoreOptions,
  files?: FilesService,
): OpenAIResponsesSessionStoreOptions {
  if (!files) {
    return options;
  }
  const mediaOptions: PrivateContentStoreOptions = {
    rootDirectory: isDurableStoreTestEnvironment()
      ? path.join(tmpdir(), 'antigravity-manager-test', 'openai-responses-media')
      : path.join(getProxyStateDir(), 'openai-responses-media'),
  };
  return {
    ...options,
    mediaStore: new OpenAIResponsesMediaStore(files.createPrivateContentStore(mediaOptions)),
  };
}
