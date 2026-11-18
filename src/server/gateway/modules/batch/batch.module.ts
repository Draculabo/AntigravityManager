import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { FilesModule } from '../files/files.module';
import { AnthropicMessageBatchesController } from './anthropic-message-batches.controller';
import { BATCH_RUNNER_OPTIONS, BatchRunnerService } from './batch-runner.service';
import { BatchService } from './batch.service';
import { resolveBatchRunnerOptions } from './batch-store-location';
import { GeminiBatchesController } from './gemini-batches.controller';
import { OpenAIBatchesController } from './openai-batches.controller';

@Module({
  imports: [FilesModule],
  controllers: [
    OpenAIBatchesController,
    AnthropicMessageBatchesController,
    GeminiBatchesController,
  ],
  providers: [
    {
      provide: BATCH_RUNNER_OPTIONS,
      useFactory: resolveBatchRunnerOptions,
    },
    BatchRunnerService,
    BatchService,
    ProxyGuard,
  ],
  exports: [BatchService],
})
export class BatchModule {}
