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
/** Discovery accepts client executable names, never product text in unrelated argv or folders. */
export function getAntigravityExecutableTarget(value: string): 'classic' | 'ide' | null {
  const normalized = value.replaceAll('\\', '/');
  const bundle = /(?:^|\/)Antigravity([ -]IDE)?\.app\/Contents\/MacOS\/[^/]+$/i.exec(normalized);
  const binary = /^(?:Antigravity)([ -]IDE)?(?:\.exe)?$/i.exec(normalized.split('/').at(-1) || '');
  const match = bundle || binary;
  return match ? (match[1] ? 'ide' : 'classic') : null;
}
