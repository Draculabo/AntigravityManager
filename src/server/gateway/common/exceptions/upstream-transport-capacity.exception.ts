import { ServiceUnavailableException } from '@nestjs/common';
import { markTerminalGenerationFailure } from '@/modules/proxy-gateway/antigravity/UpstreamGenerationError';

/** Local transport admission must not rotate or penalize provider accounts. */
export class UpstreamTransportCapacityError extends ServiceUnavailableException {
  constructor() {
    super('Upstream connection capacity is unavailable. Retry later.');
    markTerminalGenerationFailure(this);
  }
}
