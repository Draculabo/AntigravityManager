import { createHash } from 'node:crypto';
import { parse, type FunctionDeclaration } from 'acorn';

export type ClaudeCoworkPatchState =
  | 'original'
  | 'legacy-return0'
  | 'legacy-35k'
  | 'current-8k'
  | 'unsupported'
  | 'ambiguous'
  | 'unreadable';

export interface ClaudeCoworkSourceStatus {
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
  sourceState?: 'original' | 'legacy-return0' | 'legacy-35k' | 'current-8k';
  targetRetainedMessages?: 8_000;
  reason?: string;
}

export type ClaudeCoworkPatchPreview =
  | { state: 'unavailable'; plan: ClaudeCoworkPatchPlan }
  | {
      state: 'ready';
      plan: ClaudeCoworkPatchPlan;
      originalSha256: string;
      patchedSha256: string;
      byteRange: { start: number; end: number };
      patchedSource: string;
    };

export const MAX_SOURCE_BYTES = 1024 * 1024;
const ORIGINAL =
  'function f(a,b,c){let s=0,g=0;for(let h=b-1;h>=0;h--)if(s+=a[h],g++,s>=c)break;if(g>=b-1)return Math.max(1,Math.floor(b/2));return g}';
const fixed = (threshold: number) =>
  `function f(a,b,c){let s=0,g=0;for(let h=b-1;h>=0;h--)if(s+=a[h],g++,s>=${threshold})break;return g;}`;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Parser-owned nodes only. Metadata and local spelling do not change the algorithm. */
function normalize(value: unknown, bindings: ReadonlyMap<string, string>, property = false): Json {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => normalize(item, bindings));
  }
  if (typeof value !== 'object') {
    return null;
  }
  if (
    'type' in value &&
    value.type === 'Identifier' &&
    'name' in value &&
    typeof value.name === 'string'
  ) {
    return {
      type: 'Identifier',
      name: property ? value.name : (bindings.get(value.name) ?? value.name),
    };
  }
  const result: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    if (['start', 'end', 'raw', 'loc', 'range'].includes(key)) {
      continue;
    }
    const memberProperty =
      key === 'property' &&
      'type' in value &&
      value.type === 'MemberExpression' &&
      'computed' in value &&
      value.computed === false;
    result[key] = normalize(child, bindings, memberProperty);
  }
  return result;
}

function algorithmBindings(
  fn: FunctionDeclaration,
  parameters: [string, string, string],
): Map<string, string> | null {
  const declaration = fn.body.body[0];
  const loop = fn.body.body[1];
  if (
    declaration?.type !== 'VariableDeclaration' ||
    declaration.declarations.length !== 2 ||
    loop?.type !== 'ForStatement' ||
    loop.init?.type !== 'VariableDeclaration' ||
    loop.init.declarations.length !== 1
  ) {
    return null;
  }
  const locals = [...declaration.declarations, ...loop.init.declarations].map((item) =>
    item.id.type === 'Identifier' ? item.id.name : null,
  );
  const [sum, kept, index] = locals;
  if (!sum || !kept || !index) {
    return null;
  }
  const names = [...parameters, sum, kept, index];
  if (
    new Set(names).size !== 6 ||
    names.includes('Math') ||
    (fn.id && names.includes(fn.id.name))
  ) {
    return null;
  }
  return new Map(names.map((name, position) => [name, ['a', 'b', 'c', 's', 'g', 'h'][position]!]));
}

function templateBody(source: string): string {
  const fn = parse(source, { ecmaVersion: 2025 }).body[0];
  if (fn?.type !== 'FunctionDeclaration') {
    throw new Error('Invalid internal Cowork algorithm template');
  }
  return JSON.stringify(normalize(fn.body, new Map()));
}
const ALGORITHMS = new Map<string, 'original' | 'legacy-35k' | 'current-8k'>([
  [templateBody(ORIGINAL), 'original'],
  [templateBody(fixed(35000)), 'legacy-35k'],
  [templateBody(fixed(8000)), 'current-8k'],
]);

interface Candidate {
  fn: FunctionDeclaration;
  parameters: [string, string, string];
  state: 'original' | 'legacy-return0' | 'legacy-35k' | 'current-8k';
}

function candidates(source: string): Candidate[] {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return [];
  }
  try {
    const program = parse(source, { ecmaVersion: 2025, sourceType: 'module' });
    if (hasMathBinding(program)) {
      return [];
    }
    const matches: Candidate[] = [];
    // Only standalone, top-level declarations are admitted. Bundled/native payloads
    // need a verified extraction contract before nested scopes can be supported.
    for (const fn of program.body) {
      if (
        fn.type !== 'FunctionDeclaration' ||
        !fn.id ||
        fn.async ||
        fn.generator ||
        fn.params.length !== 3
      ) {
        continue;
      }
      const [first, second, third] = fn.params;
      if (
        first?.type !== 'Identifier' ||
        second?.type !== 'Identifier' ||
        third?.type !== 'Identifier'
      ) {
        continue;
      }
      const parameters: [string, string, string] = [first.name, second.name, third.name];
      if (new Set(parameters).size !== 3) {
        continue;
      }
      const statement = fn.body.body[0];
      if (
        fn.body.body.length === 1 &&
        statement?.type === 'ReturnStatement' &&
        statement.argument?.type === 'Literal' &&
        statement.argument.value === 0
      ) {
        matches.push({ fn, parameters, state: 'legacy-return0' });
        continue;
      }
      const bindings = algorithmBindings(fn, parameters);
      const state = bindings && ALGORITHMS.get(JSON.stringify(normalize(fn.body, bindings)));
      if (state) {
        matches.push({ fn, parameters, state });
      }
    }
    return matches;
  } catch {
    // Syntax errors, unsupported payloads and parser stack limits all deny a plan.
    return [];
  }
}

/** A shadowed Math invalidates the original algorithm's intrinsic calls. */
function hasMathBinding(value: unknown, binding = false): boolean {
  if (Array.isArray(value)) {
    return value.some((item: unknown) => hasMathBinding(item, binding));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (
    binding &&
    'type' in value &&
    value.type === 'Identifier' &&
    'name' in value &&
    value.name === 'Math'
  ) {
    return true;
  }
  for (const [key, child] of Object.entries(value)) {
    if (hasMathBinding(child, binding || ['id', 'params', 'param', 'local'].includes(key))) {
      return true;
    }
  }
  return false;
}

export function classifyClaudeCoworkSource(source: string): ClaudeCoworkSourceStatus {
  const matches = candidates(source);
  if (matches.length === 0) {
    return {
      state: 'unsupported',
      matchedFunctions: 0,
      reason: 'No verified standalone pruning algorithm within the source budget.',
    };
  }
  if (matches.length !== 1) {
    return {
      state: 'ambiguous',
      matchedFunctions: matches.length,
      reason: 'Multiple pruning functions require explicit disambiguation.',
    };
  }
  return { state: matches[0]!.state, matchedFunctions: 1 };
}

export function planClaudeCoworkPatch(source: string): ClaudeCoworkPatchPlan {
  const status = classifyClaudeCoworkSource(source);
  if (status.state === 'unsupported' || status.state === 'ambiguous') {
    return { ...status, state: status.state };
  }
  const match = candidates(source)[0]!;
  if (match.state === 'legacy-return0' || match.state === 'legacy-35k') {
    return {
      state: 'unsupported',
      matchedFunctions: 1,
      sourceState: match.state,
      reason: 'Legacy upgrades require version-matched original recovery material.',
    };
  }
  return {
    state: match.state === 'current-8k' ? 'already-current' : 'ready',
    matchedFunctions: 1,
    targetFunctionName: match.fn.id?.name,
    parameterNames: match.parameters,
    sourceState: match.state,
    targetRetainedMessages: 8000,
  };
}

/** Pure preview; this does not grant permission to apply to an installed runtime. */
export function previewClaudeCoworkPatch(source: string): ClaudeCoworkPatchPreview {
  const plan = planClaudeCoworkPatch(source);
  if (plan.state !== 'ready') {
    return { state: 'unavailable', plan };
  }
  const match = candidates(source)[0]!;
  const [array, count, limit] = match.parameters;
  const localNames: string[] = [];
  for (const name of ['s', 'g', 'h', 'i', 'j', 'k', 'l']) {
    if (!match.parameters.includes(name) && name !== match.fn.id?.name) {
      localNames.push(name);
    }
  }
  const [sum, kept, index] = localNames;
  const replacement = `function ${match.fn.id?.name}(${array},${count},${limit}){let ${sum}=0,${kept}=0;for(let ${index}=${count}-1;${index}>=0;${index}--)if(${sum}+=${array}[${index}],${kept}++,${sum}>=8000)break;return ${kept};}`;
  const input = Buffer.from(source, 'utf8');
  const start = Buffer.byteLength(source.slice(0, match.fn.start), 'utf8');
  const end = Buffer.byteLength(source.slice(0, match.fn.end), 'utf8');
  const padding = end - start - Buffer.byteLength(replacement, 'utf8');
  if (padding < 4) {
    return {
      state: 'unavailable',
      plan: {
        state: 'unsupported',
        matchedFunctions: 1,
        reason: 'The verified function has insufficient equal-length replacement space.',
      },
    };
  }
  const output = Buffer.from(input);
  output.write(`${replacement}/*${' '.repeat(padding - 4)}*/`, start, end - start, 'utf8');
  const patchedSource = output.toString('utf8');
  if (
    classifyClaudeCoworkSource(patchedSource).state !== 'current-8k' ||
    !output.subarray(0, start).equals(input.subarray(0, start)) ||
    !output.subarray(end).equals(input.subarray(end))
  ) {
    return {
      state: 'unavailable',
      plan: {
        state: 'unsupported',
        matchedFunctions: 1,
        reason: 'The replacement failed structural or byte-preservation checks.',
      },
    };
  }
  return {
    state: 'ready',
    plan,
    originalSha256: createHash('sha256').update(input).digest('hex'),
    patchedSha256: createHash('sha256').update(output).digest('hex'),
    byteRange: { start, end },
    patchedSource,
  };
}
