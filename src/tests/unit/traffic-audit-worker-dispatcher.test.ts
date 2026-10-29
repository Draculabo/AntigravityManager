import { describe, expect, it, vi } from 'vitest';
import { createTrafficAuditWorkerDispatcher } from '@/modules/proxy-gateway/audit/traffic-audit-worker-dispatcher';
import type { TrafficAuditRepository } from '@/modules/proxy-gateway/audit/traffic-audit.repository';

const config = {
  bodyRetentionHours: 24,
  summaryRetentionDays: 30,
  maxRows: 1000,
  maxDiskBytes: 1024,
};
function fixture() {
  const events: string[] = [];
  const repository = {
    execute: vi.fn<TrafficAuditRepository['execute']>((command) => {
      events.push(command.operation);
      return command.operation === 'stats' ? { rows: 10 } : true;
    }),
    maintenance: vi.fn<TrafficAuditRepository['maintenance']>(function* () {
      events.push('slice-one');
      yield;
      events.push('slice-two');
      return { databaseBytes: 512 };
    }),
  };
  const replies: unknown[] = [];
  const dispatch = createTrafficAuditWorkerDispatcher(repository, (reply) => replies.push(reply));
  return { repository, dispatch, events, replies };
}

describe('traffic audit worker maintenance ownership', () => {
  it('interleaves reads without advancing or restarting another maintenance pass', () => {
    const { dispatch, repository, events, replies } = fixture();
    dispatch(1, { operation: 'maintenance', payload: config });
    dispatch(2, { operation: 'configure', payload: { ...config, maxRows: 2000 } });
    dispatch(3, { operation: 'stats', payload: null });
    dispatch(1, { operation: 'maintenance', payload: config });
    dispatch(2, { operation: 'configure', payload: { ...config, maxRows: 2000 } });
    dispatch(2, { operation: 'configure', payload: { ...config, maxRows: 2000 } });
    expect(events).toEqual(['slice-one', 'stats', 'slice-two', 'slice-one', 'slice-two']);
    expect(repository.maintenance.mock.calls).toEqual([[config], [{ ...config, maxRows: 2000 }]]);
    expect(replies).toEqual([
      { id: 1, yielded: true },
      { id: 2, yielded: true },
      { id: 3, result: { rows: 10 } },
      { id: 1, result: { databaseBytes: 512 } },
      { id: 2, yielded: true },
      { id: 2, result: { databaseBytes: 512 } },
    ]);
  });

  it('releases failed maintenance and preserves its error before another pass starts', () => {
    const { dispatch, repository, replies } = fixture();
    repository.maintenance.mockImplementationOnce(function* () {
      yield;
      throw new Error('reclamation failed');
    });
    dispatch(1, { operation: 'maintenance', payload: config });
    dispatch(1, { operation: 'maintenance', payload: config });
    dispatch(2, { operation: 'configure', payload: config });
    dispatch(2, { operation: 'configure', payload: config });
    expect(replies).toEqual([
      { id: 1, yielded: true },
      { id: 1, error: 'reclamation failed' },
      { id: 2, yielded: true },
      { id: 2, result: { databaseBytes: 512 } },
    ]);
  });

  it('reports interrupted work before acknowledging direct shutdown and rejects later calls', () => {
    const { dispatch, events, replies } = fixture();
    dispatch(1, { operation: 'maintenance', payload: config });
    dispatch(2, { operation: 'shutdown', payload: null });
    dispatch(1, { operation: 'maintenance', payload: config });
    expect(events).toEqual(['slice-one', 'shutdown']);
    expect(replies).toEqual([
      { id: 1, yielded: true },
      { id: 1, error: 'Traffic audit maintenance interrupted by shutdown' },
      { id: 2, result: true },
      { id: 1, error: 'Traffic audit worker is closed' },
    ]);
  });
});
