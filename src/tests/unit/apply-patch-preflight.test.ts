import { describe, expect, it } from 'vitest';

import {
  optimizeApplyPatch,
  validateApplyPatchV4A,
} from '@/modules/proxy-gateway/antigravity/ApplyPatchPreflight';

describe('apply_patch preflight', () => {
  it('converts unified diff file headers into a V4A update operation', () => {
    const input = [
      '*** Begin Patch',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    const result = optimizeApplyPatch(input);

    expect(result.input).toBe(
      [
        '*** Begin Patch',
        '*** Update File: src/example.ts',
        '@@',
        '-const value = 1;',
        '+const value = 2;',
        '*** End Patch',
      ].join('\n'),
    );
    expect(result.repairs).toEqual([
      {
        file: 'src/example.ts',
        kind: 'converted-unified-file-header',
        detail: 'Converted ---/+++ headers to *** Update File.',
      },
    ]);
    expect(validateApplyPatchV4A(result.input)).toBeNull();
  });

  it('converts a file header into a V4A update operation', () => {
    const input = [
      '*** Begin Patch',
      'file: src/example.ts',
      '@@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    const result = optimizeApplyPatch(input);

    expect(result.input).toContain('*** Update File: src/example.ts');
    expect(result.input).not.toContain('file: src/example.ts');
    expect(validateApplyPatchV4A(result.input)).toBeNull();
  });

  it('removes line ranges from unified hunk headers', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@ -1,2 +1,2 @@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    const result = optimizeApplyPatch(input);

    expect(result.input).toContain('\n@@\n');
    expect(result.input).not.toContain('@@ -1,2 +1,2 @@');
    expect(validateApplyPatchV4A(result.input)).toBeNull();
  });

  it('removes line ranges when the unified hunk header has no closing marker', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@ -1 +1',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    const result = optimizeApplyPatch(input);

    expect(result.input).toContain('\n@@\n');
    expect(result.input).not.toContain('@@ -1 +1');
    expect(validateApplyPatchV4A(result.input)).toBeNull();
  });

  it('removes the unsupported closing marker from named V4A hunks', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@ export function example() @@',
      '-  return 1;',
      '+  return 2;',
      '*** End Patch',
    ].join('\n');

    const result = optimizeApplyPatch(input);

    expect(result.input).toContain('@@ export function example()');
    expect(result.input).not.toContain('@@ export function example() @@');
    expect(validateApplyPatchV4A(result.input)).toBeNull();
  });

  it('adds the required prefix to plain lines in an Add File operation', () => {
    const input = [
      '*** Begin Patch',
      '*** Add File: src/example.ts',
      'export const value = 1;',
      '',
      'export const enabled = true;',
      '*** End Patch',
    ].join('\n');

    const result = optimizeApplyPatch(input);

    expect(result.input).toContain(
      ['*** Add File: src/example.ts', '+export const value = 1;', '+'].join('\n'),
    );
    expect(result.input).toContain('+export const enabled = true;');
    expect(validateApplyPatchV4A(result.input)).toBeNull();
  });

  it('adds a missing V4A envelope when the input starts with a patch operation', () => {
    const input = [
      '*** Update File: src/example.ts',
      '@@',
      '-const value = 1;',
      '+const value = 2;',
    ].join('\n');

    const result = optimizeApplyPatch(input);

    expect(result.input).toBe(
      [
        '*** Begin Patch',
        '*** Update File: src/example.ts',
        '@@',
        '-const value = 1;',
        '+const value = 2;',
        '*** End Patch',
      ].join('\n'),
    );
    expect(validateApplyPatchV4A(result.input)).toBeNull();
  });

  it('rejects unified diff file headers that remain after optimization', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '*** End Patch',
    ].join('\n');

    expect(validateApplyPatchV4A(input)).toEqual({
      line: 3,
      message: 'Unified diff file headers are not valid V4A syntax.',
    });
  });

  it('rejects unified hunk ranges that remain after optimization', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    expect(validateApplyPatchV4A(input)).toEqual({
      line: 3,
      message: 'Unified diff hunk ranges are not valid V4A syntax.',
    });
  });

  it('rejects nested patch envelope markers', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '*** Begin Patch',
      '@@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    expect(validateApplyPatchV4A(input)).toEqual({
      line: 3,
      message: 'Patch envelope markers may only appear once.',
    });
  });

  it('rejects unrecognized patch control markers', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '*** Rename File: src/renamed.ts',
      '*** End Patch',
    ].join('\n');

    expect(validateApplyPatchV4A(input)).toEqual({
      line: 3,
      message: 'Unrecognized V4A patch control marker.',
    });
  });

  it('rejects an unprefixed empty line inside an Update File hunk', () => {
    const input = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@',
      '',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    expect(validateApplyPatchV4A(input)).toEqual({
      line: 4,
      message: 'Patch content line is missing a V4A prefix.',
    });
  });
});
