import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AccountLeaseModule } from './modules/account-lease/account-lease.module';
import { AnthropicModule } from './modules/anthropic/anthropic.module';
import { BatchModule } from './modules/batch/batch.module';
import { FilesModule } from './modules/files/files.module';
import { GeminiModule } from './modules/gemini/gemini.module';
import { OpenAIModule } from './modules/openai/openai.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { V1InternalPassthroughModule } from './modules/v1internal-passthrough/v1internal-passthrough.module';
import { BatchExecutionTargetBinder } from './batch-execution-target.binder';
import { ProxyService } from './proxy.service';
import { UpstreamCaptureContextInterceptor } from './common/upstream-capture-context';

@Module({
  imports: [
    AccountLeaseModule,
    BatchModule,
    FilesModule,
    GeminiModule,
    AnthropicModule,
    OpenAIModule,
    UploadsModule,
    V1InternalPassthroughModule,
  ],
  providers: [
    ProxyService,
    BatchExecutionTargetBinder,
    {
      provide: APP_INTERCEPTOR,
      useClass: UpstreamCaptureContextInterceptor,
    },
  ],
  exports: [ProxyService, AccountLeaseModule],
})
export class ProxyModule {}
