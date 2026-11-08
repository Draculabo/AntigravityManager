import { describe, expect, it } from 'vitest';
import {
  classifyClaudeCoworkSource,
  planClaudeCoworkPatch,
  previewClaudeCoworkPatch,
} from '@/modules/antigravity-runtime/binary-patch/claudeCoworkRuntime';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

// Structural reconstruction of the frozen original reverse-accumulation algorithm.
const original =
  'function prune(costs,count,limit){let sum=0,kept=0;for(let index=count-1;index>=0;index--)if(sum+=costs[index],kept++,sum>=limit)break;if(kept>=count-1)return Math.max(1,Math.floor(count/2));return kept}';
const patched = (threshold: number) =>
  `function prune(costs,count,limit){let sum=0,kept=0;for(let index=count-1;index>=0;index--)if(sum+=costs[index],kept++,sum>=${threshold})break;return kept;}`;

describe('Cowork structural source planning', () => {
  it('recognizes the bound original algorithm and the distinct 8k/35k loop forms', () => {
    expect(classifyClaudeCoworkSource(original).state).toBe('original');
    expect(planClaudeCoworkPatch(original)).toMatchObject({
      state: 'ready',
      parameterNames: ['costs', 'count', 'limit'],
    });
    expect(classifyClaudeCoworkSource(patched(8000)).state).toBe('current-8k');
    expect(classifyClaudeCoworkSource(patched(35000)).state).toBe('legacy-35k');
  });

  it.each([
    JSON.stringify(original),
    `/* ${original} */`,
    'function unrelated(a,b,c){return a.filter(x=>x>=8000)}',
    'function unrelated(a,b,c){return 35000}',
    original.replace('costs[index]', 'limit[index]'),
    original.replace('return kept}', 'return sum}'),
    original.replace('let sum=0,kept=0', 'let sum=0,costs=0'),
  ])('refuses text examples, unrelated functions and binding drift: %#', (source) => {
    expect(planClaudeCoworkPatch(source).state).not.toBe('ready');
    expect(classifyClaudeCoworkSource(source).state).not.toBe('current-8k');
  });

  it('treats multiple matching functions as ambiguous even when their states agree', () => {
    const source = `${original}\n${original.replace('prune(', 'another(')}`;
    expect(classifyClaudeCoworkSource(source).state).toBe('ambiguous');
    expect(planClaudeCoworkPatch(source).state).toBe('ambiguous');
  });

  it('classifies return-zero legacy state but requires original recovery material before planning', () => {
    const source = 'function prune(a,b,c){return 0}';
    expect(classifyClaudeCoworkSource(source).state).toBe('legacy-return0');
    expect(planClaudeCoworkPatch(source).state).toBe('unsupported');
  });

  it('refuses unverified binary payloads and source beyond the parse budget', () => {
    expect(planClaudeCoworkPatch(`\u0000\u0001${original}`).state).toBe('unsupported');
    expect(planClaudeCoworkPatch(' '.repeat(1024 * 1024) + original).state).toBe('unsupported');
  });

  it('preserves every byte outside the function and the total UTF-8 length', () => {
    const prefix = 'const note="中文🧪";\n';
    const suffix = '\nconst untouched = () => [1,2,3].slice(1);';
    const source = prefix + original + suffix;
    const preview = previewClaudeCoworkPatch(source);
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') {
      throw new Error('Missing structural preview');
    }
    const input = Buffer.from(source);
    const output = Buffer.from(preview.patchedSource);
    expect(output.length).toBe(input.length);
    expect(preview.byteRange).toEqual({
      start: Buffer.byteLength(prefix),
      end: Buffer.byteLength(prefix + original),
    });
    expect(output.subarray(0, preview.byteRange.start)).toEqual(
      input.subarray(0, preview.byteRange.start),
    );
    expect(output.subarray(preview.byteRange.end)).toEqual(input.subarray(preview.byteRange.end));
    expect(preview.originalSha256).toBe(createHash('sha256').update(input).digest('hex'));
    expect(preview.patchedSha256).toBe(createHash('sha256').update(output).digest('hex'));
    expect(classifyClaudeCoworkSource(preview.patchedSource).state).toBe('current-8k');
    expect(previewClaudeCoworkPatch(preview.patchedSource)).toMatchObject({
      state: 'unavailable',
      plan: { state: 'already-current' },
    });
  });

  it('does not reuse parameter names as replacement locals', () => {
    const source = original
      .replaceAll('costs', 's')
      .replaceAll('count', 'g')
      .replaceAll('limit', 'h');
    const preview = previewClaudeCoworkPatch(source);
    expect(preview.state).toBe('ready');
    if (preview.state === 'ready') {
      expect(classifyClaudeCoworkSource(preview.patchedSource).state).toBe('current-8k');
    }
  });

  it('rejects nested and expression forms without a verified payload scope contract', () => {
    expect(planClaudeCoworkPatch(`function wrapper(){${original}}`).state).toBe('unsupported');
    expect(planClaudeCoworkPatch(`const wrapper=${original};`).state).toBe('unsupported');
  });

  it.each(['const Math = fake;', 'const {Math} = fake;', 'function Math(){}'])(
    'refuses shadowed intrinsic bindings: %s',
    (binding) => {
      expect(planClaudeCoworkPatch(binding + original).state).toBe('unsupported');
    },
  );

  it('handles minified bindings that exhaust six common replacement local names', () => {
    const source = original
      .replaceAll('prune', 's')
      .replaceAll('costs', 'g')
      .replaceAll('count', 'h')
      .replaceAll('limit', 'i');
    expect(previewClaudeCoworkPatch(source).state).toBe('ready');
  });

  it('executes the preview with the fixed 8k cutoff independently of the caller limit', () => {
    const preview = previewClaudeCoworkPatch(original);
    if (preview.state !== 'ready') {
      throw new Error('Missing runnable preview');
    }
    const result: unknown = runInNewContext(
      `${preview.patchedSource};[prune([1000,4000,4000],3,1),prune([500,1000],2,99999),prune([],0,99999)]`,
      {},
      { timeout: 1000 },
    );
    expect(result).toEqual([2, 2, 0]);
  });
});
