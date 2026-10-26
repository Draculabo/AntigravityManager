import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyClaudeCoworkSource,
  discoverClaudeCoworkRuntimes,
  inspectClaudeCoworkRuntime,
  planClaudeCoworkPatch,
} from '@/modules/antigravity-runtime/binary-patch/claudeCoworkRuntime';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cowork-'));
}

describe('Claude Cowork runtime inspection', () => {
  it('classifies the patch state inside the matching function instead of any unrelated 8k text', () => {
    expect(
      classifyClaudeCoworkSource(
        'const note = "8000";\nfunction prune(items) { const kept = items.slice(); return 35000; }',
      ).state,
    ).toBe('legacy-35k');
    expect(
      classifyClaudeCoworkSource(
        'function prune(items) { const kept = items.slice(); return items.filter((x) => x >= 8000); }',
      ).state,
    ).toBe('current-8k');
  });

  it('rejects multiple recognized states as ambiguous', () => {
    expect(
      classifyClaudeCoworkSource(
        'function a(items) { return 35000; }\nfunction b(items) { return 0; }',
      ).state,
    ).toBe('ambiguous');
  });

  it('creates a write-free plan only for one uniquely bound pruning function', () => {
    expect(
      planClaudeCoworkPatch(
        'function prune(history, system, tools) { return history.filter((item) => item >= 8000); }',
      ),
    ).toMatchObject({
      state: 'already-current',
      targetFunctionName: 'prune',
      parameterNames: ['history', 'system', 'tools'],
      targetRetainedMessages: 8000,
    });
    expect(
      planClaudeCoworkPatch('function prune(history, system, tools) { return 35000; }'),
    ).toMatchObject({ state: 'ready', sourceState: 'legacy-35k' });
    expect(
      planClaudeCoworkPatch(
        'function prune(history, system, tools) { return 35000; }\nfunction other(a, b, c) { return 0; }',
      ).state,
    ).toBe('ambiguous');
    expect(planClaudeCoworkPatch('function prune(history, system) { return 35000; }').state).toBe(
      'ambiguous',
    );
  });

  it('discovers only real Claude filenames and does not follow symlinks', () => {
    const root = makeTempRoot();
    const nested = path.join(root, 'Claude.app', 'Contents', 'MacOS');
    fs.mkdirSync(nested, { recursive: true });
    const binary = path.join(nested, 'Claude');
    fs.writeFileSync(binary, 'function prune(items) { return 0; }');
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
    fs.writeFileSync(path.join(root, 'Claude'), 'function prune(items) { return 0; }');
    const candidates = discoverClaudeCoworkRuntimes({
      roots: [root],
      maxCandidates: 1,
      maxFileBytes: 1,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sha256).toBeNull();
  });
});
