import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { createThoughtSessionKey } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { ProxyGuard } from '../../guards/proxy.guard';

interface EndThoughtSessionBody {
  session_id?: unknown;
  sessionId?: unknown;
}

@Controller('v1/thinking')
@UseGuards(ProxyGuard)
export class ThinkingController {
  @Post('end')
  @HttpCode(HttpStatus.OK)
  public async endSession(
    @Body() body: EndThoughtSessionBody,
    @Req() request: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    const sessionId = readSessionId(body);
    if (!sessionId) {
      throw new BadRequestException('session_id is required');
    }
    const affected = await thoughtStoreService.endSession(this.toSessionKey(request, sessionId));
    trafficAuditService.recordAdminOperation('end_thought_session', affected);
    return { ended: affected > 0, session_id: sessionId };
  }

  @Get('sessions/:sessionId')
  public async getSession(
    @Param('sessionId') sessionId: string,
    @Req() request: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    const records = await thoughtStoreService.getSession(this.toSessionKey(request, sessionId));
    return { records, session_id: sessionId };
  }

  @Delete('sessions/:sessionId')
  public async deleteSession(
    @Param('sessionId') sessionId: string,
    @Req() request: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    const affected = await thoughtStoreService.deleteSession(this.toSessionKey(request, sessionId));
    trafficAuditService.recordAdminOperation('delete_thought_session', affected);
    return { deleted: affected > 0, session_id: sessionId };
  }

  private toSessionKey(request: FastifyRequest, sessionId: string): string {
    return createThoughtSessionKey(request.headers as Record<string, unknown>, sessionId);
  }
}

function readSessionId(body: EndThoughtSessionBody): string | null {
  const value = body.session_id ?? body.sessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
