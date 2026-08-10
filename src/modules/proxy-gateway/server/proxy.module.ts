import { Module } from '@nestjs/common';

import { AccountLeaseModule } from './modules/account-lease/account-lease.module';
import { AnthropicModule } from './modules/anthropic/anthropic.module';
import { GeminiModule } from './modules/gemini/gemini.module';
import { OpenAIModule } from './modules/openai/openai.module';
import { ProxyService } from './proxy.service';

@Module({
  imports: [AccountLeaseModule, GeminiModule, AnthropicModule, OpenAIModule],
  providers: [ProxyService],
  exports: [ProxyService, AccountLeaseModule],
})
export class ProxyModule {}
