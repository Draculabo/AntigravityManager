import {
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { tap, type Observable } from 'rxjs';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';

class AdminOperationAuditInterceptor<TResult> implements NestInterceptor<TResult, TResult> {
  constructor(
    private readonly operation: string,
    private readonly affectedCount?: (result: TResult) => number,
  ) {}

  intercept(_context: ExecutionContext, next: CallHandler<TResult>): Observable<TResult> {
    return next.handle().pipe(
      tap((result) => {
        if (this.affectedCount) {
          trafficAuditService.recordAdminOperation(this.operation, this.affectedCount(result));
        } else {
          trafficAuditService.recordAdminOperation(this.operation);
        }
      }),
    );
  }
}

/** Records a single-result management operation after success, before sending its response.
 * The projector must match the handler's return type. Mutation and recorder failures still propagate.
 */
export function AuditAdminOperation<TResult = unknown>(
  operation: string,
  affectedCount?: (result: TResult) => number,
): MethodDecorator {
  return UseInterceptors(new AdminOperationAuditInterceptor(operation, affectedCount));
}
