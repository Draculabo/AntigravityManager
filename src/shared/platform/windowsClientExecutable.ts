import fs from 'node:fs';
import path from 'node:path';

/** Discovery never executes candidates or accepts a relative PATH entry. */
export function findWindowsClientExecutables(target: 'classic' | 'ide'): string[] {
  const names =
    target === 'ide' ? ['Antigravity IDE', 'antigravity-ide', 'antigravity_ide'] : ['Antigravity'];
  const local = process.env.LOCALAPPDATA;
  const roots = [
    ...(local ? [path.win32.join(local, 'Programs'), local] : []),
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    ...(process.env.ProgramW6432 ? [process.env.ProgramW6432] : []),
  ];
  const candidates = roots.flatMap((root) =>
    names.flatMap((folder) => names.map((name) => path.win32.join(root, folder, `${name}.exe`))),
  );
  for (const entry of (process.env.PATH || '').split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (path.win32.isAbsolute(directory)) {
      candidates.push(...names.map((name) => path.win32.join(directory, `${name}.exe`)));
    }
  }
  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      continue;
    }
    // A Classic-named binary inside an IDE layout needs explicit configuration.
    if (target === 'classic' && /(?:^|[\\/])antigravity[ _-]ide(?:[\\/]|$)/i.test(candidate)) {
      continue;
    }
    const canonical = fs.realpathSync.native(candidate).toLowerCase();
    if (!found.some((file) => fs.realpathSync.native(file).toLowerCase() === canonical)) {
      found.push(candidate);
    }
  }
  return found;
}
