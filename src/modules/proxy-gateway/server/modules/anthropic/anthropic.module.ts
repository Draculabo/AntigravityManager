import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiModule } from '../gemini/gemini.module';
import { AnthropicController } from './anthropic.controller';
import { AnthropicService } from './anthropic.service';

@Module({
  imports: [AccountLeaseModule, GeminiModule],
  controllers: [AnthropicController],
  providers: [AnthropicService, ProxyGuard],
  exports: [AnthropicService],
})
export class AnthropicModule {}
