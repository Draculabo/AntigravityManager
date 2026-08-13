import { Module } from '@nestjs/common';

import { AccountLeaseModule } from './modules/account-lease/account-lease.module';
import { AnthropicModule } from './modules/anthropic/anthropic.module';
import { BatchModule } from './modules/batch/batch.module';
import { GeminiModule } from './modules/gemini/gemini.module';
import { OpenAIModule } from './modules/openai/openai.module';
import { V1InternalPassthroughModule } from './modules/v1internal-passthrough/v1internal-passthrough.module';
import { ProxyService } from './proxy.service';

@Module({
  imports: [
    AccountLeaseModule,
    GeminiModule,
    AnthropicModule,
    OpenAIModule,
    BatchModule,
    V1InternalPassthroughModule,
  ],
  providers: [ProxyService],
  exports: [ProxyService, AccountLeaseModule],
})
export class ProxyModule {}
