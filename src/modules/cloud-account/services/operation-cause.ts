import { z } from 'zod';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import {
  NativeDiagnosticCodeSchema,
  UpstreamDiagnosticCodeSchema,
  type CauseClassification,
  type HttpResponseEvidence,
  CauseClassificationSchema,
  OperationReportSchema,
  type OperationReport,
} from '@/shared/observability/operationDiagnostic';

/** Carries only observed classifications; the original cause stays in the owning process. */
export class GoogleApiDiagnosticError extends Error {
  constructor(
    message: string,
    readonly classification: CauseClassification,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GoogleApiDiagnosticError';
  }
}

export function upstreamClassification(
  status: number,
  code?: unknown,
  http?: HttpResponseEvidence,
): CauseClassification {
  const parsed = UpstreamDiagnosticCodeSchema.safeParse(code);
  const observedStatus = CauseClassificationSchema.shape.upstreamStatus.safeParse(status);
  return {
    reason: 'http-rejected',
    ...(http ? { http } : {}),
    ...(observedStatus.success ? { upstreamStatus: observedStatus.data } : {}),
    ...(parsed.success ? { upstreamCode: parsed.data } : {}),
  };
}

const ErrorFieldsSchema = z.object({ code: z.unknown().optional(), cause: z.unknown().optional() });

function classifyOne(error: unknown): CauseClassification {
  if (error instanceof GoogleApiDiagnosticError) {
    return error.classification;
  }
  if (error instanceof UpstreamProxyConfigurationError) {
    return { reason: 'proxy-configuration-invalid' };
  }
  const fields = ErrorFieldsSchema.safeParse(error);
  const code = NativeDiagnosticCodeSchema.safeParse(fields.success ? fields.data.code : undefined);
  if (!code.success) {
    return { reason: 'unknown' };
  }
  let reason: CauseClassification['reason'];
  switch (code.data) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      reason = 'dns-failed';
      break;
    case 'ECONNREFUSED':
      reason = 'connection-refused';
      break;
    case 'ECONNRESET':
      reason = 'connection-reset';
      break;
    case 'ETIMEDOUT':
    case 'ECONNABORTED':
    case 'timed-out':
      reason = 'timed-out';
      break;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      reason = 'tls-failed';
      break;
    case 'EACCES':
    case 'EPERM':
    case 'permission-denied':
      reason = 'permission-denied';
      break;
    case 'SQLITE_BUSY':
    case 'SQLITE_LOCKED':
    case 'locked':
      reason = 'locked';
      break;
    case 'KEYCHAIN_UNAVAILABLE':
    case 'MASTER_KEY_UNAVAILABLE':
    case 'unavailable':
      reason = 'unavailable';
      break;
    case 'EIO':
    case 'ENOSPC':
    case 'SQLITE_READONLY':
    case 'SQLITE_CORRUPT':
    case 'SQLITE_CANTOPEN':
      reason = 'storage-failed';
      break;
    default:
      reason = 'unknown';
  }
  return { reason, nativeCode: code.data };
}

export function classifyOperationCause(error: unknown): {
  primary: CauseClassification;
  causes: CauseClassification[];
  causesTruncated: boolean;
  sourceLocations?: OperationReport['sourceLocations'];
} {
  const seen = new Set<unknown>();
  const causes: CauseClassification[] = [];
  let current = error;
  let causesTruncated = false;
  const sourceLocations: NonNullable<OperationReport['sourceLocations']> = [];
  while (current !== undefined) {
    if (seen.has(current) || causes.length === 4) {
      causesTruncated = true;
      break;
    }
    seen.add(current);
    if (current instanceof Error && typeof current.stack === 'string') {
      // Retain only verified repository suffixes and numeric coordinates, never caller paths or prose.
      const frames = current.stack
        .slice(0, 16_384)
        .matchAll(/(src[\\/]modules[\\/][A-Za-z0-9_./\\-]+\.ts):(\d+):(\d+)/g);
      for (const frame of frames) {
        const location = OperationReportSchema.shape.sourceLocations.unwrap().element.safeParse({
          filename: frame[1].replaceAll('\\', '/'),
          lineno: Number(frame[2]),
          colno: Number(frame[3]),
        });
        if (
          location.success &&
          sourceLocations.length < 4 &&
          !sourceLocations.some((value) => JSON.stringify(value) === JSON.stringify(location.data))
        ) {
          sourceLocations.push(location.data);
        }
      }
    }
    causes.push(classifyOne(current));
    const fields = ErrorFieldsSchema.safeParse(current);
    current = fields.success ? fields.data.cause : undefined;
  }
  const primary = causes.find(
    (value) => value.reason !== 'unknown' && value.reason !== 'network-failed',
  ) ??
    causes.find((value) => value.reason !== 'unknown') ??
    causes.find((value) => value.nativeCode !== undefined) ?? { reason: 'unknown' as const };
  return {
    primary,
    causes,
    causesTruncated,
    ...(sourceLocations.length ? { sourceLocations } : {}),
  };
}
