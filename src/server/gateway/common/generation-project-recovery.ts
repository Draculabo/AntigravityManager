import { UpstreamRequestError } from './exceptions/upstream-request.exception';

const recoveredRequests = new WeakSet<AbortSignal>();

/** A request's signal carries one project recovery allowance across protocol handoffs. */
export function admitGenerationProjectRecovery(
  error: unknown,
  signal: AbortSignal | undefined,
  project?: string,
): boolean {
  if (signal?.aborted || (signal && recoveredRequests.has(signal)) || !(error instanceof Error)) {
    return false;
  }
  const upstream = error instanceof UpstreamRequestError ? error : undefined;
  const status = upstream?.status;
  if (status !== undefined && status !== 400 && status !== 403 && status !== 404) {
    return false;
  }
  const message = error.message.slice(0, 4096);
  const resource =
    /\binvalid project resource name\s+['"]?projects\/([\w.-]+)|\bresource\s+['"]?projects\/([\w.-]+)['"]?\s+could not be found/iu.exec(
      message,
    );
  const projectId = project?.startsWith('projects/') ? project.slice('projects/'.length) : project;
  const matchingResource = Boolean(projectId && (resource?.[1] ?? resource?.[2]) === projectId);
  const knownLicenseRejection =
    /configured to use a Google Cloud Project but lack a Gemini Code Assist license\.\s*\(#3501\)/iu.test(
      message,
    );
  if (
    !knownLicenseRejection &&
    !matchingResource &&
    !(status === 403 && upstream?.projectConsumerDenied)
  ) {
    return false;
  }
  if (signal) {
    recoveredRequests.add(signal);
  }
  return true;
}
