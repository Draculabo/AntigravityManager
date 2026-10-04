const WINDOWS_UPDATE_BASE_URL =
  'https://raw.githubusercontent.com/Draculabo/AntigravityManager/release-updates';

export function getWindowsUpdateBaseUrl({
  platform = process.platform,
  arch = process.arch,
}: {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
} = {}) {
  return `${WINDOWS_UPDATE_BASE_URL}/${platform}/${arch}`;
}

export function getWindowsNsisUpdateBaseUrl(arch: NodeJS.Architecture = process.arch): string {
  return `${WINDOWS_UPDATE_BASE_URL}/nsis/win32/${arch}`;
}
