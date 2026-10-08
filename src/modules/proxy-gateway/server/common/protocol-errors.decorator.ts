import {
  HttpException,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable } from 'rxjs';
import type { FastifyReply, FastifyRequest } from 'fastify';

type ProtocolErrorMapper = (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  statusCode: number;
  body: object;
};

class ProtocolErrorInterceptor implements NestInterceptor<unknown> {
  constructor(private readonly mapError: ProtocolErrorMapper) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const http = context.switchToHttp();
        const response = this.mapError(
          error,
          http.getRequest<FastifyRequest>(),
          http.getResponse<FastifyReply>(),
        );
        throw new HttpException(response.body, response.statusCode);
      }),
    );
  }
}

/**
 * Maps handler failures in the entry's dialect; guard denials keep Nest's existing handling.
 * Use either class or method scope for an entry, since nesting would remap the HTTP exception.
 * Mappers may read headers assigned by a passthrough handler to preserve protocol correlation IDs.
 */
export function ProtocolErrors(mapError: ProtocolErrorMapper): ClassDecorator & MethodDecorator {
  return UseInterceptors(new ProtocolErrorInterceptor(mapError));
}
