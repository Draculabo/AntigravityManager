import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { FilesModule } from '../files/files.module';
import { SharedServicesModule } from '../../shared/shared-services.module';
import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiClient } from './gemini-client.service';
import { GeminiController } from './gemini.controller';
import { GeminiService } from './gemini.service';
import { Upstream4xxCaptureService } from '../../common/upstream-4xx-capture.service';

/**
 * `BatchModule` needs `GeminiService` to build its execution target, so it
 * imports this module. `GeminiController` needs `BatchRunnerService` the
 * other way, to serve `:batchGenerateContent` on its own model-actions route
 * -- but this module does **not** import `BatchModule` back: that static
 * import would recreate the exact class-definition cycle `forwardRef` cannot
 * fix at the ES module level (only NestJS's own DI graph, not `import`
 * evaluation order). `GeminiController` instead resolves `BatchRunnerService`
 * lazily through `ModuleRef.get(..., { strict: false })`, which walks the
 * whole application's DI graph rather than this module's own `imports`.
 */
@Module({
  imports: [AccountLeaseModule, FilesModule, SharedServicesModule],
  controllers: [GeminiController],
  providers: [GeminiClient, GeminiService, ProxyGuard, Upstream4xxCaptureService],
  exports: [GeminiClient, GeminiService],
})
export class GeminiModule {}
