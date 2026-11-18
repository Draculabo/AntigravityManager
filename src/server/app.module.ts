import { Module } from '@nestjs/common';
import { ProxyModule } from './gateway/proxy.module';

@Module({
  imports: [ProxyModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
