const DEFAULT_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const DEFAULT_CLIENT_SECRET = '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';

export function getGoogleClientId(): string {
  const env = process.env.GOOGLE_OAUTH_CLIENT_ID;
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : DEFAULT_CLIENT_ID;
}

export function getGoogleClientSecret(): string {
  const env = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : DEFAULT_CLIENT_SECRET;
}
