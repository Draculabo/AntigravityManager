import { describe, expect, it } from 'vitest';

import {
  extractCustomToolInput,
  toCustomToolArguments,
} from '../../modules/proxy-gateway/antigravity/CustomToolCall';

describe('CustomToolCall', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';

  it.each([
    [{ command: ['apply_patch', patch] }, patch],
    [{ command: `apply_patch\n${patch}` }, patch],
    [{ command: `apply_patch ${patch}` }, patch],
    [{ patch_text: patch }, patch],
    [{ input: patch }, patch],
    [{ patch }, patch],
    [{ diff: patch }, patch],
    [{ content: patch }, patch],
  ])('extracts the raw patch from supported Responses payloads', (args, expected) => {
    expect(extractCustomToolInput('apply_patch', args)).toBe(expected);
  });

  it('uses the freeform input representation upstream', () => {
    expect(toCustomToolArguments('apply_patch', patch)).toEqual({
      input: patch,
    });
  });
});
