import { describe, expect, it } from 'vitest';

import { TrafficSearchSchema } from '@/routes/traffic';
import { TrafficAuditListInputSchema } from '@/modules/proxy-gateway/audit/traffic-audit.types';

describe('Traffic Monitor route search', () => {
  it('preserves a bounded full saved session key and rejects empty or oversized filters at the owner', () => {
    expect(TrafficSearchSchema.parse({ sessionId: ' tenant-one:session_% ' }).sessionId).toBe(
      'tenant-one:session_%',
    );
    expect(
      TrafficAuditListInputSchema.parse({ sessionId: ' tenant-one:session_% ' }).sessionId,
    ).toBe('tenant-one:session_%');
    for (const sessionId of ['', '   ', 'x'.repeat(513)]) {
      expect(TrafficSearchSchema.parse({ sessionId }).sessionId).toBeUndefined();
      expect(TrafficAuditListInputSchema.safeParse({ sessionId }).success).toBe(false);
    }
  });
  it('falls back to model requests for the retired reasoning tab', () => {
    expect(TrafficSearchSchema.parse({ tab: 'thought', page: 3 }).tab).toBe('model');
  });
});
