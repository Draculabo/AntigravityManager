import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findWindowsClientExecutables } from '@/shared/platform/windowsClientExecutable';

let files: Set<string>;
beforeEach(() => {
  files = new Set();
  vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\fixture\\AppData\\Local');
  vi.stubEnv('ProgramFiles', 'C:\\Programs');
  vi.stubEnv('ProgramFiles(x86)', 'C:\\Programs32');
  vi.stubEnv('ProgramW6432', 'C:\\Programs64');
  vi.stubEnv('PATH', '');
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => files.has(String(file)));
  vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
  vi.spyOn(fs.realpathSync, 'native').mockImplementation((file) => String(file));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  'C:\\Users\\fixture\\AppData\\Local\\Antigravity\\Antigravity.exe',
  'C:\\Programs64\\Antigravity\\Antigravity.exe',
])('discovers the additional install layout %s', (file) => {
  files.add(file);
  expect(findWindowsClientExecutables('classic')).toEqual([file]);
});
it.each(['antigravity-ide', 'antigravity_ide'])(
  'discovers IDE naming variant %s without selecting it for Classic',
  (name) => {
    const file = `C:\\Programs\\${name}\\${name}.exe`;
    files.add(file);
    expect([findWindowsClientExecutables('ide'), findWindowsClientExecutables('classic')]).toEqual([
      [file],
      [],
    ]);
  },
);
it('uses only absolute PATH directories and preserves competing installations', () => {
  vi.stubEnv('PATH', ';.\\relative;"D:\\Custom App";E:\\Other;D:\\Custom App');
  const a = 'D:\\Custom App\\Antigravity.exe';
  const b = 'E:\\Other\\Antigravity.exe';
  files = new Set([a, b, 'relative\\Antigravity.exe']);
  expect(findWindowsClientExecutables('classic')).toEqual([a, b]);
});
it('does not infer Classic from a generic binary in an IDE directory', () => {
  vi.stubEnv('PATH', 'D:\\antigravity_ide');
  files.add('D:\\antigravity_ide\\Antigravity.exe');
  expect([findWindowsClientExecutables('classic'), findWindowsClientExecutables('ide')]).toEqual([
    [],
    [],
  ]);
});
it('deduplicates aliases of the same physical executable', () => {
  const a = 'C:\\Programs\\Antigravity\\Antigravity.exe';
  const b = 'C:\\Programs64\\Antigravity\\Antigravity.exe';
  files = new Set([a, b]);
  vi.mocked(fs.realpathSync.native).mockReturnValue(a);
  expect(findWindowsClientExecutables('classic')).toEqual([a]);
});
