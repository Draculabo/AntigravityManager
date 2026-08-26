import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|d\.ts)$/;

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function runGit(rootDir, args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Unable to run git ${args.join(' ')}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }

  return result.stdout;
}

function collectWorktreeSourcePaths(rootDir) {
  return runGit(rootDir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(
      (filePath) =>
        SOURCE_FILE_PATTERN.test(filePath) && ts.sys.fileExists(path.join(rootDir, filePath)),
    )
    .map(toPosixPath)
    .sort((left, right) => left.localeCompare(right));
}

function loadCompilerOptions(rootDir) {
  const configPath = path.join(rootDir, 'tsconfig.json');

  if (!ts.sys.fileExists(configPath)) {
    return {
      baseUrl: rootDir,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);

  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    rootDir,
    undefined,
    configPath,
  );

  if (parsed.errors.length > 0) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, '\n'));
  }

  return parsed.options;
}

function getStringModuleSpecifier(node) {
  return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
}

function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];
  const addSpecifier = (kind, specifier, runtime) => {
    specifiers.push({ kind, runtime, specifier });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = getStringModuleSpecifier(node);

      if (specifier) {
        addSpecifier('import', specifier, node.importClause?.isTypeOnly !== true);
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = getStringModuleSpecifier(node);

      if (specifier) {
        addSpecifier('export', specifier, node.isTypeOnly !== true);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;

      if (expression && ts.isStringLiteral(expression)) {
        addSpecifier('import-equals', expression.text, true);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;

      if (!ts.isStringLiteral(argument)) {
        ts.forEachChild(node, visit);
        return;
      }

      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addSpecifier('dynamic-import', argument.text, true);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        addSpecifier('require', argument.text, true);
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

function resolveInternalTarget(rootDir, sourcePath, specifier, compilerOptions, trackedPaths) {
  const resolved = ts.resolveModuleName(
    specifier,
    path.join(rootDir, sourcePath),
    compilerOptions,
    ts.sys,
  ).resolvedModule;

  if (!resolved) {
    return null;
  }

  const relativeTarget = toPosixPath(path.relative(rootDir, resolved.resolvedFileName));

  if (
    relativeTarget.startsWith('../') ||
    path.isAbsolute(relativeTarget) ||
    !trackedPaths.has(relativeTarget)
  ) {
    return null;
  }

  return relativeTarget;
}

/**
 * Parse the current Git worktree TypeScript and JavaScript source set into a reusable import graph.
 *
 * @param {string} rootDir repository root
 * @returns {{ formatVersion: number, repositoryRoot: string, files: Array<{ path: string, dependencies: Array<{ kind: string, runtime: boolean, specifier: string, target: string | null }> }> }} graph report
 */
export function collectImportGraph(rootDir) {
  const repositoryRoot = path.resolve(rootDir);
  const compilerOptions = loadCompilerOptions(repositoryRoot);
  const sourcePaths = collectWorktreeSourcePaths(repositoryRoot);
  const worktreePaths = new Set(sourcePaths);
  const files = sourcePaths.map((sourcePath) => {
    const sourceText = ts.sys.readFile(path.join(repositoryRoot, sourcePath));

    if (sourceText === undefined) {
      throw new Error(`Unable to read worktree source file: ${sourcePath}`);
    }

    const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
    const dependencies = collectModuleSpecifiers(sourceFile).map((dependency) => ({
      ...dependency,
      target: resolveInternalTarget(
        repositoryRoot,
        sourcePath,
        dependency.specifier,
        compilerOptions,
        worktreePaths,
      ),
    }));

    return { path: sourcePath, dependencies };
  });

  return {
    formatVersion: 1,
    repositoryRoot,
    files,
  };
}

/**
 * Follow runtime dependencies from the provided entry paths.
 *
 * @param {ReturnType<typeof collectImportGraph>} graph import graph report
 * @param {string[]} entryPaths repository-relative entry paths
 * @returns {string[]} sorted reachable repository-relative source paths
 */
export function collectRuntimeReachablePaths(graph, entryPaths) {
  const filesByPath = new Map(graph.files.map((file) => [file.path, file]));
  const visited = new Set();
  const pending = [...entryPaths];

  while (pending.length > 0) {
    const currentPath = pending.pop();

    if (!currentPath || visited.has(currentPath) || !filesByPath.has(currentPath)) {
      continue;
    }

    visited.add(currentPath);
    const file = filesByPath.get(currentPath);

    for (const dependency of file.dependencies) {
      if (dependency.runtime && dependency.target && !visited.has(dependency.target)) {
        pending.push(dependency.target);
      }
    }
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    console.log(
      JSON.stringify(collectImportGraph(path.resolve(import.meta.dirname, '..')), null, 2),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Import graph collection failed: ${message}`);
    process.exitCode = 1;
  }
}
