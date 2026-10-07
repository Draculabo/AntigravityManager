import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditWindowsX64Sizes,
  bytesToMiB,
  DEFAULT_WINDOWS_X64_SIZE_BUDGETS,
  formatAuditReport,
} from '../../../scripts/audit-windows-x64-size.mjs';

function writeSizedFile(filePath: string, bytes: number) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '');
  truncateSync(filePath, bytes);
}

const fixtureRoots: string[] = [];

async function createFixtureRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-size-audit-'));
  fixtureRoots.push(rootDir);
  return rootDir;
}

afterEach(() => {
  for (const rootDir of fixtureRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

describe('Windows x64 package size audit', () => {
  it('passes when all Windows x64 artifacts are within budget', async () => {
    const rootDir = await createFixtureRoot();

    writeSizedFile(
      path.join(
        rootDir,
        'out/make/squirrel.windows/x64/Antigravity.Manager-0.16.0-win32-x64-setup.exe',
      ),
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
    writeSizedFile(
      path.join(rootDir, 'out/Antigravity Manager-win32-x64/resources/standalone/node/node.exe'),
      90,
    );

    const result = auditWindowsX64Sizes({
      rootDir,
      budgets: {
        setupExeMiB: 100 / 1024 / 1024,
        fullNupkgMiB: 100 / 1024 / 1024,
        msiMiB: 100 / 1024 / 1024,
        appAsarMiB: 100 / 1024 / 1024,
        standaloneMiB: 100 / 1024 / 1024,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when an artifact exceeds its budget', async () => {
    const rootDir = await createFixtureRoot();

    writeSizedFile(
      path.join(
        rootDir,
        'out/make/squirrel.windows/x64/Antigravity.Manager-0.16.0-win32-x64-setup.exe',
      ),
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
    writeSizedFile(
      path.join(rootDir, 'out/Antigravity Manager-win32-x64/resources/standalone/node/node.exe'),
      90,
    );

    const result = auditWindowsX64Sizes({
      rootDir,
      budgets: {
        setupExeMiB: 100 / 1024 / 1024,
        fullNupkgMiB: 100 / 1024 / 1024,
        msiMiB: 100 / 1024 / 1024,
        appAsarMiB: 100 / 1024 / 1024,
        standaloneMiB: 100 / 1024 / 1024,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(formatAuditReport(result)).toContain('setup.exe');
  });

  it('converts bytes to MiB', () => {
    expect(bytesToMiB(1024 * 1024)).toBe(1);
  });

  it('accepts installers with the traced runtime while auditing each resource separately', async () => {
    const rootDir = await createFixtureRoot();
    const artifacts = [
      ['out/make/squirrel.windows/x64/Antigravity.Manager-0.22.0-win32-x64-setup.exe', 179.27],
      ['out/make/squirrel.windows/x64/antigravity_manager-0.22.0-full.nupkg', 179.38],
      ['out/make/wix/x64/Antigravity.Manager_0.22.0_x64_en-US.msi', 182.75],
      ['out/Antigravity Manager-win32-x64/resources/app.asar', 107.67],
      ['out/Antigravity Manager-win32-x64/resources/standalone/node/node.exe', 88.68],
      ['out/Antigravity Manager-win32-x64/resources/standalone/core/main.cjs', 20.59],
    ] as const;
    for (const [file, sizeMiB] of artifacts) {
      writeSizedFile(path.join(rootDir, file), Math.round(sizeMiB * 1024 * 1024));
    }
    // Acceptance profiles and older packages outside this output are not release artifacts.
    writeSizedFile(
      path.join(rootDir, 'out/acceptance/Antigravity Manager-win32-x64/resources/app.asar'),
      121 * 1024 * 1024,
    );

    const budgets = DEFAULT_WINDOWS_X64_SIZE_BUDGETS;
    const result = auditWindowsX64Sizes({ rootDir, budgets });
    expect(result.ok).toBe(true);
    expect(result.records).toMatchObject([
      { id: 'setupExe', ok: true },
      { id: 'fullNupkg', ok: true },
      { id: 'msi', ok: true },
      { id: 'appAsar', ok: true },
      { id: 'standalone', ok: true },
    ]);
    const standaloneBytes = Math.round(88.68 * 1024 * 1024) + Math.round(20.59 * 1024 * 1024);
    expect(result.records[4]).toEqual({
      id: 'standalone',
      label: 'Standalone runtime',
      filePath: path.join(rootDir, 'out/Antigravity Manager-win32-x64/resources/standalone'),
      sizeBytes: standaloneBytes,
      sizeMiB: bytesToMiB(standaloneBytes),
      budgetMiB: budgets.standaloneMiB,
      ok: true,
      message: 'Standalone runtime is within budget',
    });

    for (const [file, budgetMiB] of [
      [artifacts[0][0], budgets.setupExeMiB],
      [artifacts[1][0], budgets.fullNupkgMiB],
      [artifacts[2][0], budgets.msiMiB],
      [artifacts[3][0], budgets.appAsarMiB],
      [artifacts[4][0], budgets.standaloneMiB - 10],
    ] as const) {
      writeSizedFile(path.join(rootDir, file), budgetMiB * 1024 * 1024 + 1);
    }
    const exceeded = auditWindowsX64Sizes({ rootDir, budgets });
    expect(exceeded.ok).toBe(false);
    expect(exceeded.failures).toMatchObject([
      { id: 'setupExe' },
      { id: 'fullNupkg' },
      { id: 'msi' },
      { id: 'appAsar' },
      { id: 'standalone' },
    ]);
  });

  it('reports missing packaged resources instead of selecting an unrelated profile', async () => {
    const rootDir = await createFixtureRoot();
    writeSizedFile(
      path.join(rootDir, 'out/acceptance/Antigravity Manager-win32-x64/resources/app.asar'),
      70,
    );
    mkdirSync(path.join(rootDir, 'out/Antigravity Manager-win32-x64/resources/app.asar'), {
      recursive: true,
    });
    writeSizedFile(
      path.join(rootDir, 'out/Antigravity Manager-win32-x64/resources/standalone'),
      70,
    );
    const result = auditWindowsX64Sizes({ rootDir });
    expect(result.failures).toMatchObject([
      { id: 'setupExe', message: 'Squirrel setup.exe is missing' },
      { id: 'fullNupkg', message: 'Squirrel full.nupkg is missing' },
      { id: 'msi', message: 'WiX MSI is missing' },
      { id: 'appAsar', message: 'app.asar is missing' },
      { id: 'standalone', message: 'Standalone runtime is missing' },
    ]);
  });
});
