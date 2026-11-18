import { ServiceUnavailableException } from '@nestjs/common';
import { markTerminalGenerationFailure } from '../../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';

/** The gateway declined a physical send before contacting an upstream account. */
export class GenerationReplayLimitError extends ServiceUnavailableException {
  readonly code = 'generation_replay_limit';

  constructor() {
    super('The generation replay limit for large upstream requests was reached.');
    markTerminalGenerationFailure(this);
  }
}
