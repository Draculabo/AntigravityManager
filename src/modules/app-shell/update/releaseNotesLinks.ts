export const RELEASE_REPOSITORY_URL = 'https://github.com/Draculabo/AntigravityManager';
export const RELEASE_HISTORY_URL = `${RELEASE_REPOSITORY_URL}/releases`;

const GITHUB_ROUTES = new Set([
  'about',
  'account',
  'apps',
  'codespaces',
  'contact',
  'copilot',
  'dashboard',
  'enterprise',
  'explore',
  'features',
  'join',
  'login',
  'logout',
  'marketplace',
  'new',
  'notifications',
  'organizations',
  'orgs',
  'pricing',
  'readme',
  'search',
  'security',
  'sessions',
  'settings',
  'signup',
  'site',
  'sponsors',
  'topics',
  'trending',
  'users',
]);

export function getTargetReleaseUrl(tagName: string): string {
  return `${RELEASE_HISTORY_URL}/tag/${encodeURIComponent(tagName)}`;
}

/** Scoped to release-note navigation; the application's general external allowlist stays narrow. */
export function isReleaseNotesLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password) {
      return false;
    }

    const pathname = parsed.pathname.replace(/\/$/u, '');
    if (/%(?:2f|5c)/iu.test(pathname)) {
      return false;
    }
    if (
      pathname === '/Draculabo/AntigravityManager' ||
      pathname.startsWith('/Draculabo/AntigravityManager/')
    ) {
      return true;
    }

    // GitHub usernames are a single segment, with no leading/trailing or consecutive hyphens.
    return (
      /^\/[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu.test(pathname) &&
      !pathname.includes('--') &&
      !GITHUB_ROUTES.has(pathname.slice(1).toLowerCase()) &&
      parsed.search === ''
    );
  } catch {
    return false;
  }
}
