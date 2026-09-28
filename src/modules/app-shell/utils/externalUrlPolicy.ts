const GITHUB_ORIGIN = 'https://github.com';
const REPOSITORY_PATH = '/Draculabo/AntigravityManager';

export function isTrustedExternalUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.origin !== GITHUB_ORIGIN ||
      parsedUrl.username !== '' ||
      parsedUrl.password !== ''
    ) {
      return false;
    }

    const pathname = parsedUrl.pathname.replace(/\/$/u, '');
    return (
      pathname === REPOSITORY_PATH ||
      pathname === `${REPOSITORY_PATH}/issues` ||
      pathname.startsWith(`${REPOSITORY_PATH}/releases/`)
    );
  } catch {
    return false;
  }
}
