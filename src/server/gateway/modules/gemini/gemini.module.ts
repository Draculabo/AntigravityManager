import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { BatchModule } from '../batch/batch.module';
import { FilesModule } from '../files/files.module';
import { SharedServicesModule } from '../../shared/shared-services.module';
import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiClient } from './gemini-client.service';
import { GeminiController } from './gemini.controller';
import { GeminiService } from './gemini.service';
import { Upstream4xxCaptureService } from '../../common/upstream-4xx-capture.service';

@Module({
  imports: [AccountLeaseModule, BatchModule, FilesModule, SharedServicesModule],
  controllers: [GeminiController],
  providers: [GeminiClient, GeminiService, ProxyGuard, Upstream4xxCaptureService],
  exports: [GeminiClient, GeminiService],
})
export class GeminiModule {}
