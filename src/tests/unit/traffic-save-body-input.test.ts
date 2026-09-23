import { describe, expect, it } from 'vitest';

import { SaveAuditBodyInputSchema } from '@/modules/proxy-gateway/audit/save-audit-body-input';

describe('traffic body save IPC input', () => {
  it('accepts the typed renderer contract and rejects malformed runtime IPC values', () => {
    const bodyId = '00000000-0000-4000-8000-000000000001';
    expect(SaveAuditBodyInputSchema.parse([bodyId, 'traffic-response.json'])).toEqual([
      bodyId,
      'traffic-response.json',
    ]);
    expect(SaveAuditBodyInputSchema.safeParse(['00000000-0000-4000', 'body.txt']).success).toBe(
      false,
    );
    expect(SaveAuditBodyInputSchema.safeParse([bodyId, { name: 'body.txt' }]).success).toBe(false);
  });
});
