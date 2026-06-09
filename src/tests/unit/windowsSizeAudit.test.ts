import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  auditWindowsX64Sizes,
  bytesToMiB,
  formatAuditReport,
} from '../../../scripts/audit-windows-x64-size.mjs';

function writeSizedFile(filePath: string, bytes: number) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.alloc(bytes));
}

describe('Windows x64 package size audit', () => {
  it('passes when all Windows x64 artifacts are within budget', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-size-audit-'));

    writeSizedFile(
      path.join(rootDir, 'out/make/squirrel.windows/x64/Antigravity.Manager_0.16.0_x64-setup.exe'),
      90,
    );
    writeSizedFile(
      path.join(rootDir, 'out/make/squirrel.windows/x64/antigravity_manager-0.16.0-full.nupkg'),
      80,
    );
    writeSizedFile(
      path.join(rootDir, 'out/make/wix/x64/Antigravity.Manager_0.16.0_x64_en-US.msi'),
      95,
    );
    writeSizedFile(path.join(rootDir, 'out/Antigravity Manager-win32-x64/resources/app.asar'), 70);

    const result = auditWindowsX64Sizes({
      rootDir,
      budgets: {
        setupExeMiB: 100 / 1024 / 1024,
        fullNupkgMiB: 100 / 1024 / 1024,
        msiMiB: 100 / 1024 / 1024,
        appAsarMiB: 100 / 1024 / 1024,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when an artifact exceeds its budget', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-size-audit-'));

    writeSizedFile(
      path.join(rootDir, 'out/make/squirrel.windows/x64/Antigravity.Manager_0.16.0_x64-setup.exe'),
      101,
    );
    writeSizedFile(
      path.join(rootDir, 'out/make/squirrel.windows/x64/antigravity_manager-0.16.0-full.nupkg'),
      80,
    );
    writeSizedFile(
      path.join(rootDir, 'out/make/wix/x64/Antigravity.Manager_0.16.0_x64_en-US.msi'),
      95,
    );
    writeSizedFile(path.join(rootDir, 'out/Antigravity Manager-win32-x64/resources/app.asar'), 70);

    const result = auditWindowsX64Sizes({
      rootDir,
      budgets: {
        setupExeMiB: 100 / 1024 / 1024,
        fullNupkgMiB: 100 / 1024 / 1024,
        msiMiB: 100 / 1024 / 1024,
        appAsarMiB: 100 / 1024 / 1024,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(formatAuditReport(result)).toContain('setup.exe');
  });

  it('converts bytes to MiB', () => {
    expect(bytesToMiB(1024 * 1024)).toBe(1);
  });
});
