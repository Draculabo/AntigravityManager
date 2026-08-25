import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectImportGraph, collectRuntimeReachablePaths } from './import-graph.mjs';

const NATIVE_MODULE_SPECIFIERS = new Set([
  '@napi-rs/keyring',
  'better-sqlite3',
  'electron',
  'keytar',
]);
const RUNTIME_BOUNDARY_ENTRIES = [
  { name: 'renderer', path: 'src/renderer.ts', permittedModules: new Set() },
  { name: 'preload', path: 'src/preload.ts', permittedModules: new Set(['electron']) },
];

function isForbiddenInternalTarget(target) {
  return (
    target === 'src/main.ts' ||
    target.startsWith('src/server/') ||
    target.startsWith('src/shared/persistence/database/') ||
    target.includes('/ipc/handler')
  );
}

function createViolation(entry, source, rule, forbidden) {
  return { entry, forbidden, rule, source };
}

function collectRuntimeEntryViolations(graph, entry) {
  const filesByPath = new Map(graph.files.map((file) => [file.path, file]));
  const reachablePaths = collectRuntimeReachablePaths(graph, [entry.path]);
  const violations = [];

  for (const source of reachablePaths) {
    const file = filesByPath.get(source);

    for (const dependency of file.dependencies) {
      if (!dependency.runtime) {
        continue;
      }

      if (
        NATIVE_MODULE_SPECIFIERS.has(dependency.specifier) &&
        !entry.permittedModules.has(dependency.specifier)
      ) {
        violations.push(
          createViolation(entry.path, source, `${entry.name}-native-module`, dependency.specifier),
        );
      }

      if (dependency.target && isForbiddenInternalTarget(dependency.target)) {
        violations.push(
          createViolation(
            entry.path,
            source,
            `${entry.name}-main-process-import`,
            dependency.target,
          ),
        );
      }
    }
  }

  return violations;
}

function collectSharedDependencyViolations(graph) {
  const violations = [];

  for (const file of graph.files) {
    if (!file.path.startsWith('src/shared/')) {
      continue;
    }

    for (const dependency of file.dependencies) {
      if (dependency.runtime && dependency.target?.startsWith('src/modules/')) {
        violations.push(
          createViolation('src/shared', file.path, 'shared-feature-dependency', dependency.target),
        );
      }
    }
  }

  return violations;
}

function collectRootIpcRouterViolations(graph) {
  const rootRouter = graph.files.find((file) => file.path === 'src/ipc/router.ts');

  if (!rootRouter) {
    return [];
  }

  return rootRouter.dependencies.flatMap((dependency) => {
    if (
      !dependency.runtime ||
      !dependency.target?.startsWith('src/modules/') ||
      dependency.target.endsWith('/ipc/router.ts')
    ) {
      return [];
    }

    return [
      createViolation(
        'src/ipc/router.ts',
        rootRouter.path,
        'root-ipc-non-router-import',
        dependency.target,
      ),
    ];
  });
}

/**
 * Verify architectural runtime boundaries from the Git-tracked source graph.
 *
 * @param {string} rootDir repository root
 * @returns {{ formatVersion: number, violations: Array<{ entry: string, forbidden: string, rule: string, source: string }> }} boundary report
 */
export function verifyRuntimeBoundaries(rootDir) {
  const graph = collectImportGraph(rootDir);
  const violations = [
    ...RUNTIME_BOUNDARY_ENTRIES.flatMap((entry) => collectRuntimeEntryViolations(graph, entry)),
    ...collectSharedDependencyViolations(graph),
    ...collectRootIpcRouterViolations(graph),
  ].sort(
    (left, right) =>
      left.entry.localeCompare(right.entry) ||
      left.source.localeCompare(right.source) ||
      left.rule.localeCompare(right.rule) ||
      left.forbidden.localeCompare(right.forbidden),
  );

  return { formatVersion: 1, violations };
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const arguments_ = new Set(process.argv.slice(2));
    const supportedArguments = new Set(['--report', '--enforce-root-ipc']);

    for (const argument of arguments_) {
      if (!supportedArguments.has(argument)) {
        throw new Error(`Unknown argument: ${argument}`);
      }
    }

    const reportMode = arguments_.has('--report');
    const enforceRootIpc = arguments_.has('--enforce-root-ipc');
    const report = verifyRuntimeBoundaries(path.resolve(import.meta.dirname, '..'));
    console.log(JSON.stringify(report, null, 2));

    const violationsToEnforce = enforceRootIpc
      ? report.violations.filter((violation) => violation.rule === 'root-ipc-non-router-import')
      : report.violations;

    if (!reportMode && violationsToEnforce.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Runtime boundary verification failed: ${message}`);
    process.exitCode = 1;
  }
}
