import { isObjectLike, isString } from 'lodash-es';

/**
 * `cloudcode-pa` answers 403 for unrelated reasons. Keep recoverable validation and network-policy
 * failures separate from durable account eligibility failures so retry policy can make an explicit
 * decision rather than inferring it from a generic `PERMISSION_DENIED` string.
 */

/** Hosts whose `ErrorInfo` may carry a user-actionable `VALIDATION_REQUIRED` 403. */
const CLOUDCODE_ERROR_DOMAINS = new Set([
  'cloudcode-pa.googleapis.com',
  'staging-cloudcode-pa.googleapis.com',
  'autopush-cloudcode-pa.googleapis.com',
]);

const VALIDATION_REQUIRED_REASON = 'VALIDATION_REQUIRED';
const SECURITY_POLICY_VIOLATED_REASON = 'SECURITY_POLICY_VIOLATED';

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
const HELP_TYPE = 'type.googleapis.com/google.rpc.Help';

const MAX_DETAILS = 16;
const MAX_HELP_LINKS = 8;
const MAX_URL_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 200;

export interface GoogleErrorHelpLink {
  description?: string;
  url?: string;
}

export interface GoogleApiErrorDetail {
  type?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
  links?: GoogleErrorHelpLink[];
}

export type ForbiddenUpstreamKind =
  | 'account_forbidden'
  | 'location_ineligible'
  | 'license_required'
  | 'validation_required'
  | 'security_policy_violated';

export interface ForbiddenUpstreamClassification {
  kind: ForbiddenUpstreamKind;
  validationLink?: string;
  validationDescription?: string;
  learnMoreUrl?: string;
}

const ACCOUNT_FORBIDDEN: ForbiddenUpstreamClassification = { kind: 'account_forbidden' };

export function isProjectLicenseErrorMessage(message: string): boolean {
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes('#3501') ||
    (normalizedMessage.includes('google cloud project') &&
      normalizedMessage.includes('code assist license'))
  );
}

/**
 * Strips stray characters that SSE framing can inject into a domain before comparing, mirroring
 * gemini-cli's `isCloudCodeDomain`.
 */
function isCloudCodeDomain(domain: string): boolean {
  return CLOUDCODE_ERROR_DOMAINS.has(domain.replace(/[^a-zA-Z0-9.-]/g, ''));
}

function sanitizeUrl(value: unknown): string | undefined {
  if (!isString(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
    return undefined;
  }
  return /^https?:\/\/[\x21-\x7e]+$/i.test(trimmed) ? trimmed : undefined;
}

function sanitizeDescription(value: unknown): string | undefined {
  if (!isString(value)) {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

function toHelpLinks(value: unknown): GoogleErrorHelpLink[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const links = value.slice(0, MAX_HELP_LINKS).flatMap((entry): GoogleErrorHelpLink[] => {
    if (!isObjectLike(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return [
      {
        description: sanitizeDescription(record.description),
        url: sanitizeUrl(record.url),
      },
    ];
  });
  return links.length > 0 ? links : undefined;
}

function toMetadata(value: unknown): Record<string, string> | undefined {
  if (!isObjectLike(value) || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => isString(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toErrorDetail(value: unknown): GoogleApiErrorDetail | null {
  if (!isObjectLike(value) || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const detail: GoogleApiErrorDetail = {
    type: isString(record['@type']) ? record['@type'] : undefined,
    reason: isString(record.reason) ? record.reason : undefined,
    domain: isString(record.domain) ? record.domain : undefined,
    metadata: toMetadata(record.metadata),
    links: toHelpLinks(record.links),
  };
  return detail;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Pulls `error.details` out of a raw upstream error payload.
 *
 * Runs against the untruncated axios payload, because `UpstreamRequestError` clips its `body` to
 * 1000 characters and a real `VALIDATION_REQUIRED` body is routinely longer than that.
 */
export function extractGoogleErrorDetails(
  responseData: unknown,
): GoogleApiErrorDetail[] | undefined {
  const payload = isString(responseData) ? parseJson(responseData) : responseData;
  if (!isObjectLike(payload)) {
    return undefined;
  }

  const errorRecord = (payload as { error?: unknown }).error;
  const rawDetails = isObjectLike(errorRecord)
    ? (errorRecord as { details?: unknown }).details
    : undefined;
  if (!Array.isArray(rawDetails)) {
    return undefined;
  }

  const details = rawDetails
    .slice(0, MAX_DETAILS)
    .map(toErrorDetail)
    .filter((detail): detail is GoogleApiErrorDetail => detail !== null);
  return details.length > 0 ? details : undefined;
}

function classifyFromDetails(
  details: GoogleApiErrorDetail[],
): ForbiddenUpstreamClassification | null {
  if (
    details.some(
      (detail) =>
        detail.reason === SECURITY_POLICY_VIOLATED_REASON ||
        detail.metadata?.reason === SECURITY_POLICY_VIOLATED_REASON,
    )
  ) {
    return { kind: 'security_policy_violated' };
  }

  const errorInfo = details.find(
    (detail) =>
      (detail.type === undefined || detail.type === ERROR_INFO_TYPE) &&
      detail.reason === VALIDATION_REQUIRED_REASON &&
      isString(detail.domain) &&
      isCloudCodeDomain(detail.domain),
  );
  if (!errorInfo) {
    return null;
  }

  const help = details.find((detail) => detail.type === HELP_TYPE && detail.links?.length);
  const links = help?.links ?? [];
  const learnMoreUrl = links.find((link) => {
    if (link.description?.toLowerCase().trim() === 'learn more') {
      return true;
    }
    if (!link.url) {
      return false;
    }
    return URL.canParse(link.url) && new URL(link.url).hostname === 'support.google.com';
  })?.url;

  return {
    kind: 'validation_required',
    validationLink: links[0]?.url ?? sanitizeUrl(errorInfo.metadata?.validation_link),
    validationDescription: links[0]?.description,
    learnMoreUrl,
  };
}

/**
 * Last-resort recognition when the structured details never made it through (for example when only
 * a truncated body survived). Deliberately narrow: `VALIDATION_REQUIRED` still requires a
 * cloudcode-pa domain to appear alongside it, exactly as the structured path does.
 */
function classifyFromText(text: string): ForbiddenUpstreamClassification | null {
  const normalizedText = text.toLowerCase();
  if (isProjectLicenseErrorMessage(normalizedText)) {
    return { kind: 'license_required' };
  }

  const namesGeminiCodeAssist = normalizedText.includes('gemini code assist');
  const namesUnavailableLocation =
    normalizedText.includes('not currently available in your location') ||
    normalizedText.includes('not currently available in your region') ||
    normalizedText.includes('not available in your location') ||
    normalizedText.includes('not available in your region');
  if (namesGeminiCodeAssist && namesUnavailableLocation) {
    return { kind: 'location_ineligible' };
  }

  if (text.includes(SECURITY_POLICY_VIOLATED_REASON)) {
    return { kind: 'security_policy_violated' };
  }

  const mentionsCloudCodeDomain = [...CLOUDCODE_ERROR_DOMAINS].some((domain) =>
    text.includes(domain),
  );
  if (!text.includes(VALIDATION_REQUIRED_REASON) || !mentionsCloudCodeDomain) {
    return null;
  }

  const linkMatch =
    /"validation_link"\s*:\s*"([^"]+)"/.exec(text) ?? /"url"\s*:\s*"([^"]+)"/.exec(text);
  return {
    kind: 'validation_required',
    validationLink: sanitizeUrl(linkMatch?.[1]),
  };
}

/**
 * Classifies a 403 into a durable account failure or one of the two recoverable conditions.
 *
 * Returns `account_forbidden` whenever no more precise condition is recognised, so the caller's
 * existing fail-closed behaviour is unchanged for every 403 we do not understand.
 */
export function classifyForbiddenUpstreamError(params: {
  details?: GoogleApiErrorDetail[];
  body?: string;
  message?: string;
}): ForbiddenUpstreamClassification {
  if (params.details && params.details.length > 0) {
    const fromDetails = classifyFromDetails(params.details);
    if (fromDetails) {
      return fromDetails;
    }
  }

  const text = [params.body, params.message].filter(isString).join('\n');
  if (text.length === 0) {
    return ACCOUNT_FORBIDDEN;
  }

  return classifyFromText(text) ?? ACCOUNT_FORBIDDEN;
}
