import { describe, expect, it } from 'vitest';

import { ApplyPatchFailureCompactor } from '@/modules/proxy-gateway/antigravity/ApplyPatchFailureCompaction';

describe('ApplyPatchFailureCompactor', () => {
  it('keeps six distinct failures and omits additional retry-loop context', () => {
    const compactor = new ApplyPatchFailureCompactor();

    for (let index = 1; index <= 6; index += 1) {
      const failure = `apply_patch verification failed\nDistinct failure ${index}`;
      expect(compactor.compact(failure)).toBe(failure);
    }

    expect(compactor.compact('apply_patch verification failed\nDistinct failure 7')).toBe(
      '[Additional apply_patch failure omitted to avoid a retry loop. Produce a fresh V4A patch from current file contents instead of repeating previous failed patches.]',
    );
  });

  it('does not compact unrelated tool output', () => {
    const compactor = new ApplyPatchFailureCompactor();

    expect(compactor.compact('Done')).toBe('Done');
  });
});
