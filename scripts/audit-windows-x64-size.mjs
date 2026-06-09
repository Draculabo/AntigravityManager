import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MIB = 1024 * 1024;

export const DEFAULT_WINDOWS_X64_SIZE_BUDGETS = {
  setupExeMiB: 150,
  fullNupkgMiB: 150,
  msiMiB: 150,
  appAsarMiB: 120,
};

export function bytesToMiB(bytes) {
  return bytes / MIB;
}

function readBudgetFromEnv(name, fallback) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got '${rawValue}'`);
  }

  return value;
}

export function getWindowsX64SizeBudgetsFromEnv() {
  return {
    setupExeMiB: readBudgetFromEnv(
      'AGM_MAX_WIN32_X64_SETUP_EXE_MB',
      DEFAULT_WINDOWS_X64_SIZE_BUDGETS.setupExeMiB,
    ),
    fullNupkgMiB: readBudgetFromEnv(
      'AGM_MAX_WIN32_X64_FULL_NUPKG_MB',
      DEFAULT_WINDOWS_X64_SIZE_BUDGETS.fullNupkgMiB,
    ),
    msiMiB: readBudgetFromEnv('AGM_MAX_WIN32_X64_MSI_MB', DEFAULT_WINDOWS_X64_SIZE_BUDGETS.msiMiB),
    appAsarMiB: readBudgetFromEnv(
      'AGM_MAX_WIN32_X64_APP_ASAR_MB',
      DEFAULT_WINDOWS_X64_SIZE_BUDGETS.appAsarMiB,
    ),
  };
}

function listFilesRecursive(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const entries = readdirSync(rootDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(entryPath);
    }

    if (entry.isFile()) {
      return [entryPath];
    }

    return [];
  });
}

function findNewestMatchingFile(rootDir, predicate) {
  const files = listFilesRecursive(rootDir).filter(predicate);
  if (files.length === 0) {
    return null;
  }

  return files.sort((left, right) => {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return rightStat.mtimeMs - leftStat.mtimeMs || rightStat.size - leftStat.size;
  })[0];
}

function createArtifactRecord({ id, label, filePath, budgetMiB }) {
  if (!filePath) {
    return {
      id,
      label,
      filePath: null,
      sizeBytes: null,
      sizeMiB: null,
      budgetMiB,
      ok: false,
      message: `${label} is missing`,
    };
  }

  const { size } = statSync(filePath);
  const sizeMiB = bytesToMiB(size);
  const ok = sizeMiB <= budgetMiB;

  return {
    id,
    label,
    filePath,
    sizeBytes: size,
    sizeMiB,
    budgetMiB,
    ok,
    message: ok
      ? `${label} is within budget`
      : `${label} is ${sizeMiB.toFixed(2)} MiB, over ${budgetMiB.toFixed(2)} MiB`,
  };
}

export function auditWindowsX64Sizes({
  rootDir = process.cwd(),
  budgets = getWindowsX64SizeBudgetsFromEnv(),
} = {}) {
  const outDir = path.join(rootDir, 'out');
  const squirrelDir = path.join(outDir, 'make', 'squirrel.windows', 'x64');
  const wixDir = path.join(outDir, 'make', 'wix', 'x64');

  const records = [
    createArtifactRecord({
      id: 'setupExe',
      label: 'Squirrel setup.exe',
      filePath: findNewestMatchingFile(
        squirrelDir,
        (filePath) => filePath.endsWith('.exe') && filePath.includes('_x64-setup'),
      ),
      budgetMiB: budgets.setupExeMiB,
    }),
    createArtifactRecord({
      id: 'fullNupkg',
      label: 'Squirrel full.nupkg',
      filePath: findNewestMatchingFile(squirrelDir, (filePath) => filePath.endsWith('-full.nupkg')),
      budgetMiB: budgets.fullNupkgMiB,
    }),
    createArtifactRecord({
      id: 'msi',
      label: 'WiX MSI',
      filePath: findNewestMatchingFile(wixDir, (filePath) => filePath.endsWith('.msi')),
      budgetMiB: budgets.msiMiB,
    }),
    createArtifactRecord({
      id: 'appAsar',
      label: 'app.asar',
      filePath: findNewestMatchingFile(
        outDir,
        (filePath) =>
          filePath.endsWith(`${path.sep}resources${path.sep}app.asar`) &&
          filePath.includes('-win32-x64'),
      ),
      budgetMiB: budgets.appAsarMiB,
    }),
  ];

  const failures = records.filter((record) => !record.ok);

  return {
    ok: failures.length === 0,
    records,
    failures,
  };
}

export function formatAuditReport(result) {
  const lines = ['Windows x64 package size audit'];

  for (const record of result.records) {
    const status = record.ok ? 'PASS' : 'FAIL';
    const size = record.sizeMiB === null ? 'missing' : `${record.sizeMiB.toFixed(2)} MiB`;
    const location = record.filePath ? ` (${path.relative(process.cwd(), record.filePath)})` : '';

    lines.push(
      `${status} ${record.label}: ${size} / ${record.budgetMiB.toFixed(2)} MiB${location}`,
    );
  }

  if (!result.ok) {
    lines.push('');
    lines.push('Failures:');
    for (const failure of result.failures) {
      lines.push(`- ${failure.message}`);
    }
  }

  return lines.join('\n');
}

function runCli() {
  const result = auditWindowsX64Sizes();
  console.log(formatAuditReport(result));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  runCli();
}
