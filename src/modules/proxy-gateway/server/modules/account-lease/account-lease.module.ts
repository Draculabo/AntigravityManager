import { Module } from '@nestjs/common';

import {
  ACCOUNT_LEASE_ACCOUNT_STORE,
  ACCOUNT_LEASE_UPSTREAM,
  cloudAccountStoreAdapter,
  googleAccountLeaseUpstreamAdapter,
} from './interfaces/account-lease-adapters';
import { AccountLeaseService } from './account-lease.service';

@Module({
  providers: [
    AccountLeaseService,
    {
      provide: ACCOUNT_LEASE_ACCOUNT_STORE,
      useValue: cloudAccountStoreAdapter,
    },
    {
      provide: ACCOUNT_LEASE_UPSTREAM,
      useValue: googleAccountLeaseUpstreamAdapter,
    },
  ],
  exports: [AccountLeaseService],
})
export class AccountLeaseModule {}
