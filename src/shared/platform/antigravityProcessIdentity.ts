/** Windows update packages are installers, not clients that can receive account state. */
export function isAntigravityWindowsInstaller(
  processName: string,
  target?: 'classic' | 'ide',
): boolean {
  const match = /^antigravity([ -]ide)?(?:setup)?-(?:x64|arm64)(?:-\d[\w.-]*)?\.exe$/i.exec(
    processName,
  );
  return Boolean(match && (!target || (match[1] ? 'ide' : 'classic') === target));
}
