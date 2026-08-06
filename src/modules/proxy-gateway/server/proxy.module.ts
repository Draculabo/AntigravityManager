import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AccountLeaseService } from './modules/account-lease/account-lease.service';
import { GeminiClient } from './modules/gemini/gemini-client.service';
import { GeminiController } from './modules/gemini/gemini.controller';
import { ProxyGuard } from './guards/proxy.guard';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { IMAGE_QUOTA_REFRESH } from './proxy.controller';

@Module({
  imports: [],
  controllers: [ProxyController, GeminiController],
  providers: [
    ProxyService,
    AccountLeaseService,
    GeminiClient,
    ProxyGuard,
    {
      provide: IMAGE_QUOTA_REFRESH,
      useValue: () => CloudMonitorService.poll(),
    },
  ],
  exports: [AccountLeaseService],
})
export class ProxyModule {}
