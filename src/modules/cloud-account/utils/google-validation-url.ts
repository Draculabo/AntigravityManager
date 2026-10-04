const TRUSTED_GOOGLE_VALIDATION_HOSTS = new Set(['accounts.google.com']);

export function normalizeTrustedGoogleValidationUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2048 || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    !TRUSTED_GOOGLE_VALIDATION_HOSTS.has(hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return undefined;
  }
  return url.toString();
}
