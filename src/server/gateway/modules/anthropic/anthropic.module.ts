import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { FilesModule } from '../files/files.module';
import { SharedServicesModule } from '../../shared/shared-services.module';
import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiModule } from '../gemini/gemini.module';
import { AnthropicCompleteController } from './anthropic-complete.controller';
import { AnthropicController } from './anthropic.controller';
import { AnthropicService } from './anthropic.service';

@Module({
  imports: [AccountLeaseModule, FilesModule, GeminiModule, SharedServicesModule],
  controllers: [AnthropicController, AnthropicCompleteController],
  providers: [AnthropicService, ProxyGuard],
  exports: [AnthropicService],
})
export class AnthropicModule {}
