import { Logger, Module } from '@nestjs/common';

import { AccountLeaseModule } from '../modules/account-lease/account-lease.module';
import { AccountLeaseService } from '../modules/account-lease/account-lease.service';
import {
  GenerationConstraintsService,
  PROXY_MODEL_CAPABILITY_READER,
} from './services/generation-constraints.service';
import {
  ModelAvailabilityService,
  proxyModelAvailabilityStore,
} from './services/model-availability.service';
import { ModelRouteMissJournalService } from './services/model-route-miss-journal.service';
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
    ModelRouteMissJournalService,
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
    // Deliberately `useValue` rather than letting the container construct it. The store is
    // application-scoped, not container-scoped: `proxy-gateway/ipc/router.ts` and
    // `cloud-account/ipc/handler.ts` read and clear it from the Electron side, where there is
    // no Nest container and the proxy server may be stopped. Handing the same instance to the
    // container makes the dependency explicit and injectable without moving its lifetime.
    {
      provide: ModelAvailabilityService,
      useValue: proxyModelAvailabilityStore,
    },
  ],
  exports: [
    ModelRoutingService,
    ModelRouteMissJournalService,
    GenerationConstraintsService,
    ProxyRetryService,
    ModelAvailabilityService,
  ],
})
export class SharedServicesModule {}
