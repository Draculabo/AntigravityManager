import { Module, type Type } from '@nestjs/common';

import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiModule } from '../gemini/gemini.module';
import { V1InternalPassthroughController } from './v1internal-passthrough.controller';
import { V1InternalPassthroughService } from './v1internal-passthrough.service';

const V1INTERNAL_PASSTHROUGH_ENABLED = process.env.AGM_V1INTERNAL_PASSTHROUGH === '1';

/**
 * Read exactly once, while Nest assembles its controller graph. A disabled diagnostic has no
 * route to guard, rather than a route that guards itself: changing the variable after startup
 * cannot open it.
 */
export function getV1InternalPassthroughControllers(): Type<unknown>[] {
  return V1INTERNAL_PASSTHROUGH_ENABLED ? [V1InternalPassthroughController] : [];
}

@Module({
  imports: [AccountLeaseModule, GeminiModule],
  controllers: getV1InternalPassthroughControllers(),
  providers: [V1InternalPassthroughService],
  exports: [V1InternalPassthroughService],
})
export class V1InternalPassthroughModule {}
