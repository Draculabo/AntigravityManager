import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type ClaudeCoworkPatchState =
  | 'original'
  | 'legacy-return0'
  | 'legacy-35k'
  | 'current-8k'
  | 'unsupported'
  | 'ambiguous'
  | 'unreadable';

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
  reason?: string;
}

export type ClaudeCoworkPatchPlanState = 'ready' | 'already-current' | 'unsupported' | 'ambiguous';

export interface ClaudeCoworkPatchPlan {
  state: ClaudeCoworkPatchPlanState;
  matchedFunctions: number;
  targetFunctionName?: string;
  parameterNames?: [string, string, string];
  sourceState?: Exclude<ClaudeCoworkPatchState, 'unsupported' | 'ambiguous' | 'unreadable'>;
  targetRetainedMessages?: 8_000;
  reason?: string;
}

export interface ClaudeCoworkDiscoveryOptions {
  roots: string[];
  customPath?: string;
  maxDepth?: number;
  maxCandidates?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_CANDIDATES = 32;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
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

function sha256File(filePath: string, maxBytes: number): { bytes: number; sha256: string | null } {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    return { bytes: stat.size, sha256: null };
  }
  const digest = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return { bytes: stat.size, sha256: digest };
}

function resolveRuntimeBinary(candidate: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
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
      if (fs.statSync(file).isFile()) {
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
  const maxBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const output: ClaudeCoworkRuntimeCandidate[] = [];

  if (options.customPath) {
    addCandidate(output, options.customPath, 'custom', maxBytes);
  }

  const queue = options.roots.map((root) => ({ root: path.resolve(root), depth: 0 }));
  const visited = new Set<string>();
  while (queue.length > 0 && output.length < maxCandidates) {
    const item = queue.shift();
    if (!item) {
      break;
    }
    const canonicalRoot = canonicalize(item.root);
    if (!canonicalRoot || visited.has(canonicalRoot)) {
      continue;
    }
    visited.add(canonicalRoot);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(canonicalRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (output.length >= maxCandidates) {
        break;
      }
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
  }
  return output;
}

function classifyFunctionBody(body: string): ClaudeCoworkPatchState[] {
  const states: ClaudeCoworkPatchState[] = [];
  if (/\breturn\s+0\s*;?/u.test(body)) {
    states.push('legacy-return0');
  }
  if (/\breturn\s+35_?000\s*;?/u.test(body) || /\breturn\s+35000\s*;?/u.test(body)) {
    states.push('legacy-35k');
  }
  if (/(?:>=|>)\s*8_?000\b/u.test(body) && /(?:slice|filter|splice|reduce)/u.test(body)) {
    states.push('current-8k');
  }
  if (states.length === 0 && /(?:slice|filter|splice|reduce)/u.test(body)) {
    states.push('original');
  }
  return states;
}

interface PruningFunctionCandidate {
  name: string;
  parameters: string[];
  states: ClaudeCoworkPatchState[];
}

function findPruningFunctionCandidates(source: string): PruningFunctionCandidate[] {
  return [
    ...source.matchAll(
      /(?:function\s+([\w$]+)|([\w$]+)\s*=)\s*\(([^)]{1,240})\)\s*(?:=>|\{)([\s\S]{0,3000}?)(?=\n\s*\}|$)/gu,
    ),
  ]
    .map((match) => {
      const parameters = match[3]
        ?.split(',')
        .map((parameter) => parameter.trim())
        .filter(Boolean);
      if (!parameters || parameters.some((parameter) => !/^[$\w]+$/u.test(parameter))) {
        return null;
      }
      return {
        name: match[1] ?? match[2] ?? '<anonymous>',
        parameters,
        states: classifyFunctionBody(match[0]),
      };
    })
    .filter((candidate): candidate is PruningFunctionCandidate => candidate !== null)
    .filter((candidate) => candidate.states.length > 0);
}

/**
 * Produces a write-free plan only when one function has a stable three-parameter
 * binding and one unambiguous pruning state. Callers must verify the candidate
 * hash again before any future write operation.
 */
export function planClaudeCoworkPatch(source: string): ClaudeCoworkPatchPlan {
  const candidates = findPruningFunctionCandidates(source);
  if (candidates.length === 0) {
    return {
      state: 'unsupported',
      matchedFunctions: 0,
      reason: 'No uniquely bindable three-parameter pruning function.',
    };
  }
  if (
    candidates.length !== 1 ||
    candidates[0]!.states.length !== 1 ||
    candidates[0]!.parameters.length !== 3
  ) {
    return {
      state: 'ambiguous',
      matchedFunctions: candidates.length,
      reason: 'Multiple candidates or variable/parameter binding drift detected.',
    };
  }

  const candidate = candidates[0]!;
  const sourceState = candidate.states[0]!;
  if (sourceState === 'current-8k') {
    return {
      state: 'already-current',
      matchedFunctions: 1,
      targetFunctionName: candidate.name,
      parameterNames: candidate.parameters as [string, string, string],
      sourceState,
      targetRetainedMessages: 8_000,
    };
  }
  if (
    sourceState === 'original' ||
    sourceState === 'legacy-return0' ||
    sourceState === 'legacy-35k'
  ) {
    return {
      state: 'ready',
      matchedFunctions: 1,
      targetFunctionName: candidate.name,
      parameterNames: candidate.parameters as [string, string, string],
      sourceState,
      targetRetainedMessages: 8_000,
    };
  }
  return {
    state: 'unsupported',
    matchedFunctions: 1,
    reason: 'The recognized function state cannot be patched safely.',
  };
}

export function classifyClaudeCoworkSource(
  source: string,
): Pick<ClaudeCoworkRuntimeStatus, 'state' | 'matchedFunctions' | 'reason'> {
  const functionBodies = [
    ...source.matchAll(
      /(?:function\s+[\w$]+|[\w$]+\s*=)\s*\([^)]{1,240}\)\s*(?:=>|\{)[\s\S]{0,3000}?(?=\n\s*\}|$)/gu,
    ),
  ].map((match) => match[0]);
  const states = functionBodies.flatMap(classifyFunctionBody);
  const unique = [...new Set(states)];
  if (unique.length === 0) {
    return {
      state: 'unsupported',
      matchedFunctions: 0,
      reason: 'No recognized history-pruning function.',
    };
  }
  if (unique.includes('current-8k') && unique.length > 1) {
    return {
      state: 'ambiguous',
      matchedFunctions: functionBodies.length,
      reason: 'Multiple patch states matched.',
    };
  }
  if (unique.includes('current-8k')) {
    return { state: 'current-8k', matchedFunctions: functionBodies.length };
  }
  if (unique.includes('legacy-return0') && unique.includes('legacy-35k')) {
    return {
      state: 'ambiguous',
      matchedFunctions: functionBodies.length,
      reason: 'Multiple legacy states matched.',
    };
  }
  if (unique.includes('legacy-return0')) {
    return { state: 'legacy-return0', matchedFunctions: functionBodies.length };
  }
  if (unique.includes('legacy-35k')) {
    return { state: 'legacy-35k', matchedFunctions: functionBodies.length };
  }
  return { state: 'original', matchedFunctions: functionBodies.length };
}

export function inspectClaudeCoworkRuntime(
  candidate: ClaudeCoworkRuntimeCandidate,
): ClaudeCoworkRuntimeStatus {
  try {
    const source = fs.readFileSync(candidate.canonicalPath, 'utf8');
    return { candidate, ...classifyClaudeCoworkSource(source) };
  } catch (error) {
    return {
      candidate,
      state: 'unreadable',
      matchedFunctions: 0,
      reason: error instanceof Error ? error.message : 'Unable to read runtime.',
    };
  }
}
