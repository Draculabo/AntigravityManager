import {
  BadRequestException,
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
  public list(@Query() query: Record<string, unknown>) {
    return trafficAuditService.list(parseOrBadRequest(AuditListQuerySchema, query));
  }

  @Get('filter-options')
  public filterOptions() {
    return trafficAuditService.filterOptions();
  }

  @Get('requests/:requestId')
  public detail(@Param('requestId') requestId: string) {
    return trafficAuditService.detail(parseUuid(requestId));
  }

  @Get('bodies/:bodyId/chunks')
  public page(@Param('bodyId') bodyId: string, @Query() query: Record<string, unknown>) {
    const parsedBodyId = parseUuid(bodyId);
    const parsedQuery = parseOrBadRequest(AuditBodyPageQuerySchema, query);
    return trafficAuditService.bodyPage({ bodyId: parsedBodyId, ...parsedQuery });
  }

  @Get('bodies/:bodyId/content')
  public async content(
    @Param('bodyId') bodyId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsedBodyId = parseUuid(bodyId);
    const firstPage = await trafficAuditService.bodyPage({
      bodyId: parsedBodyId,
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
    return new StreamableFile(Readable.from(trafficAuditService.bodyContent(parsedBodyId)));
  }

  @Delete('requests/:requestId')
  public async delete(@Param('requestId') requestId: string) {
    return { affected: await trafficAuditService.delete(parseUuid(requestId)) };
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
  public list(@Query() query: Record<string, unknown>) {
    const input = parseOrBadRequest(ThoughtListQuerySchema, query);
    return thoughtStoreService.listSessions(input.limit, input.offset);
  }

  @Get('sessions/:sessionKey')
  public get(@Param('sessionKey') sessionKey: string) {
    return thoughtStoreService.getSession(parseSessionKey(sessionKey));
  }

  @Delete('sessions/:sessionKey')
  public async delete(@Param('sessionKey') sessionKey: string) {
    const affected = await thoughtStoreService.deleteSession(parseSessionKey(sessionKey));
    trafficAuditService.recordAdminOperation('delete_thought_session', affected);
    return { affected };
  }

  @Delete('sessions')
  public async clear() {
    const affected = await thoughtStoreService.clear();
    trafficAuditService.recordAdminOperation('clear_thought_sessions', affected);
    return { affected };
  }

  @Post('repair')
  @HttpCode(HttpStatus.OK)
  public async repair() {
    const result = await thoughtStoreService.repair();
    trafficAuditService.recordAdminOperation('repair_thought_store');
    return result;
  }
}

function parseUuid(value: string): string {
  return parseOrBadRequest(z.string().uuid(), value);
}

function parseSessionKey(value: string): string {
  return parseOrBadRequest(z.string().trim().min(1).max(512), value);
}

function parseOrBadRequest<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(result.error.flatten());
  }
  return result.data;
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
