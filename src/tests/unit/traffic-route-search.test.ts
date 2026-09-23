import { describe, expect, it } from 'vitest';

import { TrafficSearchSchema } from '@/routes/traffic';

describe('Traffic Monitor route search', () => {
  it('falls back to model requests for the retired reasoning tab', () => {
    expect(TrafficSearchSchema.parse({ tab: 'thought', page: 3 }).tab).toBe('model');
  });
});
