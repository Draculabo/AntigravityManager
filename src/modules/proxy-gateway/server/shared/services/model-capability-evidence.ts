import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import {
  classifyForbiddenUpstreamError,
  extractGoogleErrorDetails,
  isProjectLicenseErrorMessage,
} from '../../common/google-error-details';

export type ModelCapabilityFailure = 'model_not_supported' | 'model_forbidden';

function normalizeModel(model: string): string {
  return model
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase();
}

/** Status alone cannot distinguish model entitlement from project, endpoint or credential failures. */
export function classifyModelCapabilityFailure(
  model: string,
  error: unknown,
): ModelCapabilityFailure | null {
  if (!(error instanceof UpstreamRequestError) || ![400, 403, 404].includes(error.status ?? 0)) {
    return null;
  }
  const text = [error.message, error.body].filter(Boolean).join('\n');
  const forbidden = classifyForbiddenUpstreamError({
    message: error.message,
    body: error.body,
    details: error.details,
  });
  if (forbidden.kind !== 'account_forbidden' || isProjectLicenseErrorMessage(text)) {
    return null;
  }
  if (/\b(?:project|endpoint|route|credentials?|authentication)\b/i.test(text)) {
    return null;
  }
  const target = normalizeModel(model);
  const details = error.details ?? extractGoogleErrorDetails(error.body) ?? [];
  for (const detail of details) {
    const namedModel = detail.metadata?.model ?? detail.metadata?.modelId;
    if (namedModel && normalizeModel(namedModel) !== target) {
      continue;
    }
    if (
      ['MODEL_NOT_FOUND', 'MODEL_NOT_SUPPORTED', 'UNSUPPORTED_MODEL'].includes(
        detail.reason ?? '',
      ) &&
      error.status !== 403
    ) {
      return 'model_not_supported';
    }
    if (
      ['MODEL_ACCESS_DENIED', 'MODEL_PERMISSION_DENIED'].includes(detail.reason ?? '') &&
      error.status === 403
    ) {
      return 'model_forbidden';
    }
  }
  const lower = text.toLowerCase();
  // Require the physical target name; an arbitrary quoted model or bare NOT_FOUND is insufficient.
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namesTarget = new RegExp(`(^|[^a-z0-9._-])${escapedTarget}($|[^a-z0-9._-])`).test(lower);
  if (!target || !namesTarget || !/\bmodel\b/i.test(text)) {
    return null;
  }
  if (
    /\b(?:tools?|schemas?|parameters?|thinking|functions?)\b/.test(lower.replaceAll(target, ''))
  ) {
    return null;
  }
  if (
    error.status !== 403 &&
    /not supported|unsupported|not found|does not exist|not available/.test(lower)
  ) {
    return 'model_not_supported';
  }
  if (
    error.status === 403 &&
    /access|permission|entitle/.test(lower) &&
    /denied|not allowed|not permitted|not have/.test(lower)
  ) {
    return 'model_forbidden';
  }
  return null;
}
