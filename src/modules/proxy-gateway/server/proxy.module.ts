import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AccountLeaseModule } from './modules/account-lease/account-lease.module';
import { AnthropicModule } from './modules/anthropic/anthropic.module';
import { GeminiModule } from './modules/gemini/gemini.module';
import { OpenAIModule } from './modules/openai/openai.module';
import { ProxyService } from './proxy.service';
import { UpstreamCaptureContextInterceptor } from './common/upstream-capture-context';

@Module({
  imports: [AccountLeaseModule, GeminiModule, AnthropicModule, OpenAIModule],
  providers: [
    ProxyService,
    {
      provide: APP_INTERCEPTOR,
      useClass: UpstreamCaptureContextInterceptor,
    },
  ],
  exports: [ProxyService, AccountLeaseModule],
})
export class ProxyModule {}
