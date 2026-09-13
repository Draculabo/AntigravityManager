import { Module } from '@nestjs/common';

import {
  ACCOUNT_LEASE_ACCOUNT_STORE,
  ACCOUNT_LEASE_UPSTREAM,
  cloudAccountStoreAdapter,
  googleAccountLeaseUpstreamAdapter,
} from './interfaces/account-lease-adapters';
import { RateLimitTrackerService } from '../../shared/services/rate-limit-tracker.service';
import {
  ModelAvailabilityService,
  proxyModelAvailabilityStore,
} from '../../shared/services/model-availability.service';
import { AccountLeaseService } from './account-lease.service';
import { ImageAccountSchedulerService } from './image-account-scheduler.service';

@Module({
  providers: [
    AccountLeaseService,
    ImageAccountSchedulerService,
    // Owns the lockout and failure-count maps. Lives here rather than in the shared module
    // because `AccountLeaseService` is its only writer, and putting it in `shared/` would
    // make `SharedServicesModule` and `AccountLeaseModule` import each other.
    RateLimitTrackerService,
    {
      provide: ModelAvailabilityService,
      useValue: proxyModelAvailabilityStore,
    },
    {
      provide: ACCOUNT_LEASE_ACCOUNT_STORE,
      useValue: cloudAccountStoreAdapter,
    },
    {
      provide: ACCOUNT_LEASE_UPSTREAM,
      useValue: googleAccountLeaseUpstreamAdapter,
    },
  ],
  exports: [AccountLeaseService, RateLimitTrackerService],
})
export class AccountLeaseModule {}
