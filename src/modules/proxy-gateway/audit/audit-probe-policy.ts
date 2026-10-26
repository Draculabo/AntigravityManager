/** Only known, read-only health and model-directory routes are eligible for noise suppression. */
export function isSuccessfulProbeCandidate(method: string, url: string): boolean {
  if (method.toUpperCase() !== 'GET') {
    return false;
  }
  const path = url.split(/[?#]/u, 1)[0];
  return /^\/(?:healthz?|v1\/models(?:\/claude)?|v1beta\/models)\/?$/u.test(path);
}
