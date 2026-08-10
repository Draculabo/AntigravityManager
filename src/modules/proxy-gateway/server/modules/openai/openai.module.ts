import { Module } from '@nestjs/common';

import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { ProxyGuard } from '../../guards/proxy.guard';
import { SharedServicesModule } from '../../shared/shared-services.module';
import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiModule } from '../gemini/gemini.module';
import { IMAGE_QUOTA_REFRESH, OpenAIController } from './openai.controller';
import { OpenAIService } from './openai.service';

@Module({
  imports: [AccountLeaseModule, GeminiModule, SharedServicesModule],
  controllers: [OpenAIController],
  providers: [
    OpenAIService,
    ProxyGuard,
    {
      provide: IMAGE_QUOTA_REFRESH,
      useValue: () => CloudMonitorService.poll(),
    },
  ],
  exports: [OpenAIService],
})
export class OpenAIModule {}
