import { Module } from '@nestjs/common';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ThinkingController } from './thinking.controller';

@Module({
  controllers: [ThinkingController],
  providers: [ProxyGuard],
})
export class ThinkingModule {}
