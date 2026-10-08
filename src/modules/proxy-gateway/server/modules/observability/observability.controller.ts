import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';

import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import {
  TrafficAuditBodyPageInputSchema,
  TrafficAuditListInputSchema,
} from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { AdminGuard } from '../../guards/admin.guard';
import { ZodSchemaPipe } from '../../common/zod-schema.pipe';
import { AuditAdminOperation } from './admin-operation-audit.decorator';

const UuidSchema = z.string().uuid();
const SessionKeySchema = z.string().trim().min(1).max(512);

const AuditListQuerySchema = TrafficAuditListInputSchema.extend({
  from: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: z.coerce.number().int().min(0).max(599).optional(),
  to: z.coerce.number().int().nonnegative().optional(),
});

const ThoughtListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const AuditBodyPageQuerySchema = TrafficAuditBodyPageInputSchema.omit({ bodyId: true }).extend({
  cursor: z.coerce.number().int().nonnegative().default(0),
  limitBytes: z.coerce
    .number()
    .int()
    .min(1)
    .max(256 * 1024)
    .default(256 * 1024),
});

@Controller('internal/audit')
@UseGuards(AdminGuard)
export class AuditManagementController {
  @Get('stats')
  public stats() {
    return trafficAuditService.stats();
  }

  @Get('requests')
  public list(
    @Query(new ZodSchemaPipe(AuditListQuerySchema)) query: z.output<typeof AuditListQuerySchema>,
  ) {
    return trafficAuditService.list(query);
  }

  @Get('filter-options')
  public filterOptions() {
    return trafficAuditService.filterOptions();
  }

  @Get('requests/:requestId')
  public detail(@Param('requestId', new ZodSchemaPipe(UuidSchema)) requestId: string) {
    return trafficAuditService.detail(requestId);
  }

  @Get('bodies/:bodyId/chunks')
  // Nest resolves parameter pipes in reverse order; preserve the UUID-first error response.
  public page(
    @Query(new ZodSchemaPipe(AuditBodyPageQuerySchema))
    query: z.output<typeof AuditBodyPageQuerySchema>,
    @Param('bodyId', new ZodSchemaPipe(UuidSchema)) bodyId: string,
  ) {
    return trafficAuditService.bodyPage({ bodyId, ...query });
  }

  @Get('bodies/:bodyId/content')
  public async content(
    @Param('bodyId', new ZodSchemaPipe(UuidSchema)) bodyId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const firstPage = await trafficAuditService.bodyPage({
      bodyId,
      cursor: 0,
      limitBytes: 1,
    });
    if (!firstPage) {
      throw new NotFoundException('Audit body not found');
    }
    reply.header('content-type', contentTypeFor(firstPage.body.kind));
    reply.header('x-audit-body-bytes', String(firstPage.body.storedBytes));
    reply.header('x-audit-body-state', firstPage.body.state);
    reply.header('x-audit-body-partial', String(firstPage.body.partial));
    return new StreamableFile(Readable.from(trafficAuditService.bodyContent(bodyId)));
  }

  @Delete('requests/:requestId')
  public async delete(@Param('requestId', new ZodSchemaPipe(UuidSchema)) requestId: string) {
    return { affected: await trafficAuditService.delete(requestId) };
  }

  @Delete('requests')
  public async clear() {
    return { affected: await trafficAuditService.clear() };
  }

  @Post('repair')
  @HttpCode(HttpStatus.OK)
  public repair() {
    return trafficAuditService.repair();
  }
}

@Controller('internal/thinking')
@UseGuards(AdminGuard)
export class ThoughtManagementController {
  @Get('stats')
  public stats() {
    return thoughtStoreService.stats();
  }

  @Get('sessions')
  public list(
    @Query(new ZodSchemaPipe(ThoughtListQuerySchema))
    query: z.output<typeof ThoughtListQuerySchema>,
  ) {
    return thoughtStoreService.listSessions(query.limit, query.offset);
  }

  @Get('sessions/:sessionKey')
  public get(@Param('sessionKey', new ZodSchemaPipe(SessionKeySchema)) sessionKey: string) {
    return thoughtStoreService.getSession(sessionKey);
  }

  @Delete('sessions/:sessionKey')
  @AuditAdminOperation('delete_thought_session', (result: { affected: number }) => result.affected)
  public async delete(
    @Param('sessionKey', new ZodSchemaPipe(SessionKeySchema)) sessionKey: string,
  ) {
    return { affected: await thoughtStoreService.deleteSession(sessionKey) };
  }

  @Delete('sessions')
  @AuditAdminOperation('clear_thought_sessions', (result: { affected: number }) => result.affected)
  public async clear() {
    return { affected: await thoughtStoreService.clear() };
  }

  @Post('repair')
  @HttpCode(HttpStatus.OK)
  @AuditAdminOperation('repair_thought_store')
  public async repair() {
    return thoughtStoreService.repair();
  }
}

function contentTypeFor(kind: 'empty' | 'json' | 'text' | 'binary' | 'sse'): string {
  if (kind === 'json') {
    return 'application/json; charset=utf-8';
  }
  if (kind === 'sse') {
    return 'text/event-stream; charset=utf-8';
  }
  return 'text/plain; charset=utf-8';
}
