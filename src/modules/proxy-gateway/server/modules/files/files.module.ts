import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ClientFilesController } from './client-files.controller';
import { FILE_STORE_OPTIONS, FileContentStore } from './file-content-store.service';
import { FilesService } from './files.service';
import { GeminiFilesController } from './gemini-files.controller';
import { resolveFileStoreOptions } from './file-store-location';

/**
 * The local file plane.
 *
 * One store, three dialects: Gemini has its own controller because its routes
 * live outside `/v1`, while OpenAI and Anthropic publish at the same `/v1/files`
 * path and are served by one controller that picks the dialect per request.
 * FilesService is the public operations seam for dependent feature modules.
 * The store remains exported for the existing reference-expansion consumers.
 */
@Module({
  controllers: [ClientFilesController, GeminiFilesController],
  providers: [
    FileContentStore,
    FilesService,
    ProxyGuard,
    {
      provide: FILE_STORE_OPTIONS,
      useFactory: resolveFileStoreOptions,
    },
  ],
  exports: [FileContentStore, FilesService],
})
export class FilesModule {}
