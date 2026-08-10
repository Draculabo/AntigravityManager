import { Logger, Module } from '@nestjs/common';

import { AccountLeaseModule } from '../modules/account-lease/account-lease.module';
import { AccountLeaseService } from '../modules/account-lease/account-lease.service';
import {
  GenerationConstraintsService,
  PROXY_MODEL_CAPABILITY_READER,
} from './services/generation-constraints.service';
import { ModelRoutingService } from './services/model-routing.service';
import {
  PROXY_RETRY_ACCOUNT_LEASE,
  PROXY_RETRY_LOGGER,
  ProxyRetryService,
} from './services/proxy-retry.service';

/**
 * Owns the services that every protocol surface shares. Before this module each of
 * `OpenAIService`, `AnthropicService` and `GeminiService` built its own copies in
 * `BaseProxyService`, which `server/README.md` rule 5 forbids and which the protocol split
 * turned from one instance into three.
 *
 * The interface-typed dependencies arrive by token so that `shared/` never imports
 * `AccountLeaseService` outside this module, keeping the two directions of the graph apart.
 */
@Module({
  imports: [AccountLeaseModule],
  providers: [
    ModelRoutingService,
    GenerationConstraintsService,
    ProxyRetryService,
    {
      provide: PROXY_MODEL_CAPABILITY_READER,
      useExisting: AccountLeaseService,
    },
    {
      provide: PROXY_RETRY_ACCOUNT_LEASE,
      useExisting: AccountLeaseService,
    },
    {
      provide: PROXY_RETRY_LOGGER,
      useValue: new Logger('ProxyRetryService'),
    },
  ],
  exports: [ModelRoutingService, GenerationConstraintsService, ProxyRetryService],
})
export class SharedServicesModule {}
