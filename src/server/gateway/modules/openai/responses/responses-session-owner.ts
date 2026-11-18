import { registerThoughtRecoveryPeer } from '../../../../../modules/proxy-gateway/thought-store/thought-recovery-peers';
import type { FilesService } from '../../files/files.service';
import { deleteResponsesRecoveryScope } from './responses-thought-recovery';
import {
  defaultOpenAIResponsesSessionStoreOptions,
  OpenAIResponsesSessionService,
} from './openai-responses-session.service';
import type { OpenAIResponsesSessionStoreOptions } from './openai-responses-session.store';

/** One lazy metadata writer survives gateway stop/start within the selected profile process. */
export class ResponsesSessionOwner {
  private current?: OpenAIResponsesSessionService;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly unregister: () => void;

  public constructor(
    private readonly options: () => OpenAIResponsesSessionStoreOptions = defaultOpenAIResponsesSessionStoreOptions,
  ) {
    this.unregister = registerThoughtRecoveryPeer('responses', (key) =>
      deleteResponsesRecoveryScope(key, (scope) => this.get().deleteThoughtSession(scope)),
    );
  }

  public get(files?: FilesService): OpenAIResponsesSessionService {
    if (this.closed) {
      throw new Error('Responses history owner is closed');
    }
    if (!this.current) {
      this.current = new OpenAIResponsesSessionService(this.options(), files);
      this.current.retainForProcess();
    } else if (files) {
      this.current.attachFiles(files);
    }
    return this.current;
  }

  public shutdown(): Promise<void> {
    this.closed = true;
    this.unregister();
    this.closePromise ??= (async () => {
      this.current?.onModuleDestroy();
      await this.current?.flushStrict();
    })();
    return this.closePromise;
  }
}

export const responsesSessionOwner = new ResponsesSessionOwner();
