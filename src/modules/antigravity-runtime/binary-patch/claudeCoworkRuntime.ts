import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  locateClaudeCoworkNativePayload,
  type ClaudeCoworkNativePayload,
} from './claudeCoworkNativePayload';
import {
  classifyClaudeCoworkSource,
  MAX_SOURCE_BYTES,
  type ClaudeCoworkPatchState,
} from './claudeCoworkSource';

export {
  classifyClaudeCoworkSource,
  planClaudeCoworkPatch,
  previewClaudeCoworkPatch,
} from './claudeCoworkSource';
export type {
  ClaudeCoworkPatchState,
  ClaudeCoworkPatchPlanState,
  ClaudeCoworkPatchPlan,
  ClaudeCoworkPatchPreview,
} from './claudeCoworkSource';

export interface ClaudeCoworkRuntimeCandidate {
  path: string;
  canonicalPath: string;
  source: 'discovered' | 'custom';
  version: string | null;
  bytes: number;
  sha256: string | null;
}

export interface ClaudeCoworkRuntimeStatus {
  candidate: ClaudeCoworkRuntimeCandidate;
  state: ClaudeCoworkPatchState;
  matchedFunctions: number;
  nativePayload?: ClaudeCoworkNativePayload;
  reason?: string;
}

export interface ClaudeCoworkDiscoveryOptions {
  roots: string[];
  customPath?: string;
  maxDepth?: number;
  maxCandidates?: number;
  maxFileBytes?: number;
  maxVisitedEntries?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_CANDIDATES = 32;
const CLAUDE_FILENAMES = new Set(['claude', 'Claude', 'claude.exe', 'Claude.exe']);

function canonicalize(value: string): string | null {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function versionFromPath(value: string): string | null {
  const match = value.match(/(?:^|[\\/])v?(\d+(?:\.\d+){1,3})(?:[\\/]|$)/u);
  return match?.[1] ?? null;
}

function sameRuntimeFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function withRuntimeFile<T>(
  filePath: string,
  inspect: (descriptor: number, bytes: number) => T,
): T {
  const pathBefore = fs.lstatSync(filePath, { bigint: true });
  if (!pathBefore.isFile()) {
    throw new Error('Runtime must be a regular file');
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameRuntimeFile(pathBefore, before) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Runtime changed during inspection or exceeded the supported file range');
    }
    const result = inspect(descriptor, Number(before.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !sameRuntimeFile(before, after) ||
      !sameRuntimeFile(before, fs.lstatSync(filePath, { bigint: true }))
    ) {
      throw new Error('Runtime changed during inspection');
    }
    return result;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRuntimeRange(descriptor: number, start: number, length: number): Buffer {
  const contents = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(
      descriptor,
      contents,
      offset,
      Math.min(64 * 1024, length - offset),
      start + offset,
    );
    if (count === 0) {
      throw new Error('Runtime changed during inspection');
    }
    offset += count;
  }
  return contents;
}

export function readRuntimeContents(
  filePath: string,
  maxBytes: number,
): { bytes: number; contents: Buffer | null } {
  return withRuntimeFile(filePath, (descriptor, bytes) => ({
    bytes,
    contents: bytes > maxBytes ? null : readRuntimeRange(descriptor, 0, bytes),
  }));
}

function sha256File(filePath: string, maxBytes: number): { bytes: number; sha256: string | null } {
  const { bytes, contents } = readRuntimeContents(filePath, maxBytes);
  return { bytes, sha256: contents ? createHash('sha256').update(contents).digest('hex') : null };
}

function resolveRuntimeBinary(candidate: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) {
    return null;
  }
  if (stat.isFile()) {
    return CLAUDE_FILENAMES.has(path.basename(candidate)) ? candidate : null;
  }
  if (!stat.isDirectory()) {
    return null;
  }
  const bundleCandidates = [
    path.join(candidate, 'Contents', 'MacOS', 'Claude'),
    path.join(candidate, 'Contents', 'MacOS', 'claude'),
    path.join(candidate, 'Claude'),
    path.join(candidate, 'claude'),
    path.join(candidate, 'claude.exe'),
  ];
  for (const file of bundleCandidates) {
    try {
      if (fs.lstatSync(file).isFile()) {
        return file;
      }
    } catch {
      // A missing layout candidate is expected while probing a bundle.
    }
  }
  return null;
}

function addCandidate(
  output: ClaudeCoworkRuntimeCandidate[],
  value: string,
  source: 'discovered' | 'custom',
  maxBytes: number,
): void {
  const binary = resolveRuntimeBinary(value);
  if (!binary) {
    return;
  }
  const canonicalPath = canonicalize(binary);
  if (!canonicalPath || output.some((entry) => entry.canonicalPath === canonicalPath)) {
    return;
  }
  const base = canonicalize(value);
  if (!base || (fs.lstatSync(value).isDirectory() && !isInsideRoot(canonicalPath, base))) {
    return;
  }
  const metadata = sha256File(canonicalPath, maxBytes);
  output.push({
    path: binary,
    canonicalPath,
    source,
    version: versionFromPath(binary),
    bytes: metadata.bytes,
    sha256: metadata.sha256,
  });
}

export function discoverClaudeCoworkRuntimes(
  options: ClaudeCoworkDiscoveryOptions,
): ClaudeCoworkRuntimeCandidate[] {
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const maxBytes = Math.min(
    MAX_SOURCE_BYTES,
    Math.max(1, options.maxFileBytes ?? MAX_SOURCE_BYTES),
  );
  const output: ClaudeCoworkRuntimeCandidate[] = [];
  const maxVisitedEntries = Math.min(4096, Math.max(1, options.maxVisitedEntries ?? 4096));
  let visitedEntries = 0;

  if (options.customPath) {
    addCandidate(output, options.customPath, 'custom', maxBytes);
  }

  const queue = options.roots.map((root) => ({ root: path.resolve(root), depth: 0 }));
  const visited = new Set<string>();
  while (queue.length > 0 && output.length < maxCandidates && visitedEntries < maxVisitedEntries) {
    const item = queue.shift();
    if (!item) {
      break;
    }
    const canonicalRoot = canonicalize(item.root);
    if (!canonicalRoot || visited.has(canonicalRoot)) {
      continue;
    }
    visited.add(canonicalRoot);
    let directory: fs.Dir;
    try {
      directory = fs.opendirSync(canonicalRoot);
    } catch {
      continue;
    }
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (output.length >= maxCandidates || visitedEntries >= maxVisitedEntries) {
          break;
        }
        visitedEntries += 1;
        const entryPath = path.join(canonicalRoot, entry.name);
        let entryStat: fs.Stats;
        try {
          entryStat = fs.lstatSync(entryPath);
        } catch {
          continue;
        }
        if (entryStat.isSymbolicLink()) {
          continue;
        }
        if (entryStat.isFile() && CLAUDE_FILENAMES.has(entry.name)) {
          addCandidate(output, entryPath, 'discovered', maxBytes);
          continue;
        }
        if (entryStat.isDirectory() && item.depth < maxDepth) {
          if (entry.name.endsWith('.app') || entry.name.toLowerCase() === 'claude') {
            addCandidate(output, entryPath, 'discovered', maxBytes);
          }
          if (isInsideRoot(entryPath, canonicalRoot)) {
            queue.push({ root: entryPath, depth: item.depth + 1 });
          }
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  return output;
}

export function inspectClaudeCoworkRuntime(
  candidate: ClaudeCoworkRuntimeCandidate,
): ClaudeCoworkRuntimeStatus {
  try {
    if (canonicalize(candidate.canonicalPath) !== candidate.canonicalPath) {
      throw new Error('Runtime no longer matches the selected canonical path');
    }
    const status = withRuntimeFile(candidate.canonicalPath, (descriptor, bytes): ClaudeCoworkRuntimeStatus => {
      if (bytes !== candidate.bytes) {
        throw new Error('Runtime no longer matches the selected candidate');
      }
      const read = (offset: number, length: number) => readRuntimeRange(descriptor, offset, length);
      const contents = candidate.sha256 && bytes <= MAX_SOURCE_BYTES ? read(0, bytes) : null;
      if (contents && createHash('sha256').update(contents).digest('hex') !== candidate.sha256) {
        throw new Error('Runtime no longer matches the selected candidate');
      }
      const nativePayload = locateClaudeCoworkNativePayload(bytes, read);
      if (nativePayload) {
        return { candidate, state: 'unsupported', matchedFunctions: 0, nativePayload };
      }
      if (!contents) {
        throw new Error('Runtime was not admitted for source inspection');
      }
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents);
      return { candidate, ...classifyClaudeCoworkSource(source) };
    });
    if (canonicalize(candidate.canonicalPath) !== candidate.canonicalPath) {
      throw new Error('Runtime no longer matches the selected canonical path');
    }
    return status;
  } catch {
    return {
      candidate,
      state: 'unreadable',
      matchedFunctions: 0,
      reason:
        'Runtime is unavailable, changed, or outside the admitted read budget. Rediscover the selected installation.',
    };
  }
}
