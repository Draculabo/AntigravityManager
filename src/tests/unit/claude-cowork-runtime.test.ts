import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyClaudeCoworkSource,
  discoverClaudeCoworkRuntimes,
  inspectClaudeCoworkRuntime,
  planClaudeCoworkPatch,
} from '@/modules/antigravity-runtime/binary-patch/claudeCoworkRuntime';

const temporaryRoots: string[] = [];
const original =
  'function prune(history,system,tools){let sum=0,kept=0;for(let index=system-1;index>=0;index--)if(sum+=history[index],kept++,sum>=tools)break;if(kept>=system-1)return Math.max(1,Math.floor(system/2));return kept}';
const fixed = (threshold: number) =>
  `function prune(history,system,tools){let sum=0,kept=0;for(let index=system-1;index>=0;index--)if(sum+=history[index],kept++,sum>=${threshold})break;return kept;}`;
const legacy = 'function prune(history,system,tools){return 0}';
function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cowork-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (
      path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith('claude-cowork-')
    ) {
      throw new Error('Unexpected Cowork fixture cleanup directory');
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe('Claude Cowork runtime inspection', () => {
  it('classifies the patch state inside the matching function instead of any unrelated 8k text', () => {
    expect(classifyClaudeCoworkSource(`const note = "8000";\n${fixed(35000)}`).state).toBe(
      'legacy-35k',
    );
    expect(classifyClaudeCoworkSource(fixed(8000)).state).toBe('current-8k');
  });

  it('rejects multiple recognized states as ambiguous', () => {
    expect(classifyClaudeCoworkSource(`${fixed(35000)}\nfunction b(a,b,c){return 0}`).state).toBe(
      'ambiguous',
    );
  });

  it('creates a write-free plan only for one uniquely bound pruning function', () => {
    expect(planClaudeCoworkPatch(fixed(8000))).toMatchObject({
      state: 'already-current',
      targetFunctionName: 'prune',
      parameterNames: ['history', 'system', 'tools'],
      targetRetainedMessages: 8000,
    });
    expect(planClaudeCoworkPatch(original)).toMatchObject({
      state: 'ready',
      sourceState: 'original',
    });
    expect(planClaudeCoworkPatch(`${fixed(35000)}\nfunction other(a,b,c){return 0}`).state).toBe(
      'ambiguous',
    );
    expect(planClaudeCoworkPatch('function prune(history, system) { return 35000; }').state).toBe(
      'unsupported',
    );
  });

  it('discovers only real Claude filenames and does not follow symlinks', () => {
    const root = makeTempRoot();
    const nested = path.join(root, 'Claude.app', 'Contents', 'MacOS');
    fs.mkdirSync(nested, { recursive: true });
    const binary = path.join(nested, 'Claude');
    fs.writeFileSync(binary, legacy);
    const link = path.join(root, 'linked');
    try {
      fs.symlinkSync(path.join(root, 'Claude.app'), link, 'junction');
    } catch {
      // Windows environments without junction privileges still exercise the real candidate.
    }
    const candidates = discoverClaudeCoworkRuntimes({ roots: [root], maxDepth: 4 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.canonicalPath).toBe(fs.realpathSync.native(binary));
    expect(inspectClaudeCoworkRuntime(candidates[0]!)).toMatchObject({ state: 'legacy-return0' });
  });

  it('honors candidate and file-size bounds', () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, 'Claude'), legacy);
    const candidates = discoverClaudeCoworkRuntimes({
      roots: [root],
      maxCandidates: 1,
      maxFileBytes: 1,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sha256).toBeNull();
    expect(inspectClaudeCoworkRuntime(candidates[0]!).state).toBe('unreadable');
  });

  it('refuses invalid UTF-8 instead of classifying replacement-decoded bytes', () => {
    const root = makeTempRoot();
    fs.writeFileSync(
      path.join(root, 'Claude'),
      Buffer.concat([Buffer.from('//'), Buffer.from([0xff]), Buffer.from('\n' + original)]),
    );
    const [candidate] = discoverClaudeCoworkRuntimes({ roots: [root] });
    expect(inspectClaudeCoworkRuntime(candidate!).state).toBe('unreadable');
  });

  it('rejects a custom bundle whose runtime escapes through a directory link', () => {
    const root = makeTempRoot();
    const external = makeTempRoot();
    const bundle = path.join(root, 'Claude.app');
    fs.mkdirSync(bundle);
    fs.mkdirSync(path.join(external, 'MacOS'));
    fs.writeFileSync(path.join(external, 'MacOS', 'Claude'), 'function prune(items) { return 0; }');
    fs.symlinkSync(external, path.join(bundle, 'Contents'), 'junction');
    expect(discoverClaudeCoworkRuntimes({ roots: [], customPath: bundle })).toEqual([]);
  });

  it('rejects a changed runtime even when its length is unchanged', () => {
    const root = makeTempRoot();
    const binary = path.join(root, 'Claude');
    fs.writeFileSync(binary, legacy);
    const [candidate] = discoverClaudeCoworkRuntimes({ roots: [root] });
    if (!candidate) {
      throw new Error('Missing fixture candidate');
    }
    fs.writeFileSync(binary, legacy.replace('return 0', 'return 1'));
    expect(inspectClaudeCoworkRuntime(candidate)).toMatchObject({
      state: 'unreadable',
      matchedFunctions: 0,
    });
  });

  it('requires rediscovery when the selected runtime changes or grows after discovery', () => {
    const root = makeTempRoot();
    const binary = path.join(root, 'Claude');
    fs.writeFileSync(binary, legacy);
    const [candidate] = discoverClaudeCoworkRuntimes({ roots: [root] });
    if (!candidate) {
      throw new Error('Missing fixture candidate');
    }
    fs.writeFileSync(binary, fixed(35000));
    expect(inspectClaudeCoworkRuntime(candidate)).toMatchObject({
      state: 'unreadable',
      matchedFunctions: 0,
    });
    const [fresh] = discoverClaudeCoworkRuntimes({ roots: [root] });
    expect(inspectClaudeCoworkRuntime(fresh!).state).toBe('legacy-35k');
  });
});
