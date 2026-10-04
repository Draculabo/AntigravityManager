import { Module } from '@nestjs/common';

import { refreshImageQuota } from './image-quota-refresh';
import { ProxyGuard } from '../../guards/proxy.guard';
import { FilesModule } from '../files/files.module';
import { SharedServicesModule } from '../../shared/shared-services.module';
import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiModule } from '../gemini/gemini.module';
import { IMAGE_QUOTA_REFRESH, OpenAIOperations } from './openai-operations.service';
import { OpenAIChatController } from './openai-chat.controller';
import { OpenAIMediaController } from './openai-media.controller';
import { OpenAIModelsController } from './openai-models.controller';
import { OpenAIService } from './openai.service';
import { OpenAIChatCompletionService } from './chat/openai-chat-completion.service';
import { OpenAIResponsesSessionService } from './responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from './responses/openai-responses-store.controller';
import { OpenAIResponsesController } from './responses/openai-responses.controller';

@Module({
  imports: [AccountLeaseModule, FilesModule, GeminiModule, SharedServicesModule],
  controllers: [
    OpenAIModelsController,
    OpenAIChatController,
    OpenAIResponsesController,
    OpenAIResponsesStoreController,
    OpenAIMediaController,
  ],
  providers: [
    OpenAIOperations,
    OpenAIChatCompletionService,
    OpenAIResponsesSessionService,
    OpenAIService,
    ProxyGuard,
    {
      provide: IMAGE_QUOTA_REFRESH,
      useValue: refreshImageQuota,
    },
  ],
  exports: [OpenAIChatCompletionService, OpenAIResponsesSessionService, OpenAIService],
})
export class OpenAIModule {}
