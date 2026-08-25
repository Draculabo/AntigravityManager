import { Module } from '@nestjs/common';

import {
  ACCOUNT_LEASE_ACCOUNT_STORE,
  ACCOUNT_LEASE_UPSTREAM,
  cloudAccountStoreAdapter,
  googleAccountLeaseUpstreamAdapter,
} from './interfaces/account-lease-adapters';
import { RateLimitTrackerService } from '../../shared/services/rate-limit-tracker.service';
import { AccountLeaseService } from './account-lease.service';

@Module({
  providers: [
    AccountLeaseService,
    // Owns the lockout and failure-count maps. Lives here rather than in the shared module
    // because `AccountLeaseService` is its only writer, and putting it in `shared/` would
    // make `SharedServicesModule` and `AccountLeaseModule` import each other.
    RateLimitTrackerService,
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
