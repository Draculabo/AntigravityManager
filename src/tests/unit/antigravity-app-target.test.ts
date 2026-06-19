import { describe, expect, it } from 'vitest';

import {
  AntigravityAppTargetSchema,
  resolveAntigravityAppTarget,
} from '@/modules/account/types';

describe('Antigravity app targets', () => {
  it('accepts agy as a switch target', () => {
    expect(AntigravityAppTargetSchema.safeParse('agy').success).toBe(true);
    expect(resolveAntigravityAppTarget('agy' as never)).toBe('agy');
  });
});
