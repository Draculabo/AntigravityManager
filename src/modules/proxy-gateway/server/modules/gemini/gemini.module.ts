import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { GeminiClient } from './gemini-client.service';
import { GeminiController } from './gemini.controller';
import { GeminiService } from './gemini.service';

@Module({
  imports: [AccountLeaseModule],
  controllers: [GeminiController],
  providers: [GeminiClient, GeminiService, ProxyGuard],
  exports: [GeminiClient, GeminiService],
})
export class GeminiModule {}
