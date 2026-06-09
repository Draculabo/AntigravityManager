import { describe, expect, it } from 'vitest';
import { shouldIgnorePackagePath } from '@/shared/packaging/forgeIgnore';

describe('Forge package ignore policy', () => {
  it('keeps runtime roots required by the packaged app', () => {
    expect(shouldIgnorePackagePath('/.vite/build/main.js')).toBe(false);
    expect(shouldIgnorePackagePath('/.vite/renderer/main_window/assets/index.js')).toBe(false);
    expect(shouldIgnorePackagePath('/node_modules/better-sqlite3/package.json')).toBe(false);
    expect(shouldIgnorePackagePath('/package.json')).toBe(false);
    expect(shouldIgnorePackagePath('/images/icon.ico')).toBe(false);
    expect(shouldIgnorePackagePath('/dist/index.html')).toBe(false);
  });

  it('excludes production sourcemaps from the shipped app', () => {
    expect(shouldIgnorePackagePath('/.vite/build/main.js.map')).toBe(true);
    expect(shouldIgnorePackagePath('/.vite/build/preload.js.map')).toBe(true);
    expect(shouldIgnorePackagePath('/.vite/renderer/main_window/assets/index.js.map')).toBe(true);
  });

  it('prunes renderer and build-time packages from packaged node_modules', () => {
    expect(shouldIgnorePackagePath('/node_modules/lucide-react/dist/cjs/lucide-react.js')).toBe(
      true,
    );
    expect(shouldIgnorePackagePath('/node_modules/@icons-pack/react-simple-icons/index.mjs')).toBe(
      true,
    );
    expect(shouldIgnorePackagePath('/node_modules/react-dom/client.js')).toBe(true);
    expect(
      shouldIgnorePackagePath('/node_modules/@tanstack/react-router-devtools/dist/index.js'),
    ).toBe(true);
    expect(shouldIgnorePackagePath('/node_modules/@esbuild/win32-x64/esbuild.exe')).toBe(true);
    expect(shouldIgnorePackagePath('/node_modules/rollup/dist/bin/rollup')).toBe(true);
  });

  it('keeps main-process runtime packages in packaged node_modules', () => {
    expect(
      shouldIgnorePackagePath('/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    ).toBe(false);
    expect(
      shouldIgnorePackagePath(
        '/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node',
      ),
    ).toBe(false);
    expect(shouldIgnorePackagePath('/node_modules/@opentelemetry/sdk-node/build/src/sdk.js')).toBe(
      false,
    );
    expect(shouldIgnorePackagePath('/node_modules/@nestjs/core/index.js')).toBe(false);
    expect(shouldIgnorePackagePath('/node_modules/zod/index.cjs')).toBe(false);
  });

  it('blocks workspace-only folders from entering app.asar', () => {
    expect(shouldIgnorePackagePath('/.codex/skills/example/SKILL.md')).toBe(true);
    expect(shouldIgnorePackagePath('/.agents/skills/example/SKILL.md')).toBe(true);
    expect(shouldIgnorePackagePath('/playwright-report/index.html')).toBe(true);
    expect(shouldIgnorePackagePath('/test-results/report.json')).toBe(true);
    expect(shouldIgnorePackagePath('/src/main.ts')).toBe(true);
  });
});
