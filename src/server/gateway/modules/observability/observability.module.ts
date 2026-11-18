import { Module } from '@nestjs/common';

import { AdminGuard } from '../../guards/admin.guard';
import { AuditManagementController, ThoughtManagementController } from './observability.controller';

@Module({
  controllers: [AuditManagementController, ThoughtManagementController],
  providers: [AdminGuard],
})
export class ObservabilityModule {}
