import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { FilesModule } from '../files/files.module';
import { OpenAIUploadsController } from './openai-uploads.controller';
import { OpenAIUploadsService } from './openai-uploads.service';

/**
 * The OpenAI Uploads protocol: a multipart session that assembles into one
 * ordinary record in the same local file store `FilesModule` exports.
 */
@Module({
  imports: [FilesModule],
  controllers: [OpenAIUploadsController],
  providers: [OpenAIUploadsService, ProxyGuard],
})
export class UploadsModule {}
