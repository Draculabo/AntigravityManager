import { describe, expect, it } from 'vitest';

import {
  AntigravityAppTargetSchema,
  resolveAntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';

describe('Antigravity app targets', () => {
  it('accepts agy as a switch target', () => {
    expect(AntigravityAppTargetSchema.safeParse('agy').success).toBe(true);
    expect(resolveAntigravityAppTarget('agy')).toBe('agy');
  });
});
