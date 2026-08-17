import { describe, expect, it, vi } from 'vitest';

import {
  MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES,
  ModelRouteMissJournalService,
} from '@/modules/proxy-gateway/server/shared/services/model-route-miss-journal.service';

describe('ModelRouteMissJournalService', () => {
  it('records a normalized miss with timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_111);

    try {
      const service = new ModelRouteMissJournalService();

      service.record('Models/Gemini-3.5-Flash');

      expect(service.getSnapshot()).toEqual([
        {
          model: 'gemini-3.5-flash',
          count: 1,
          lastSeen: 1_700_000_000_111,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('increments count and refreshes lastSeen when same model is repeated', () => {
    vi.useFakeTimers();

    try {
      const service = new ModelRouteMissJournalService();

      vi.setSystemTime(1_700_000_000_111);
      service.record('models/gemini-3.5-flash');
      vi.setSystemTime(1_700_000_000_222);
      service.record('models/gemini-3.5-flash');

      expect(service.getSnapshot()).toEqual([
        {
          model: 'gemini-3.5-flash',
          count: 2,
          lastSeen: 1_700_000_000_222,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts only the oldest miss entry when the bound is reached', () => {
    vi.useFakeTimers();

    try {
      const service = new ModelRouteMissJournalService();

      for (let index = 0; index < MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES; index += 1) {
        vi.setSystemTime(1_700_000_000_000 + index);
        service.record(`models/model-${index}`);
      }
      vi.setSystemTime(1_700_000_000_999);
      service.record('models/model-overflow');
      const snapshot = service.getSnapshot();

      expect(snapshot).toHaveLength(MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES);
      expect(snapshot[0]).toEqual({
        model: 'model-overflow',
        count: 1,
        lastSeen: 1_700_000_000_999,
      });
      expect(snapshot.at(-1)).toEqual({
        model: 'model-1',
        count: 1,
        lastSeen: 1_700_000_000_001,
      });
      expect(snapshot.find((entry) => entry.model === 'model-0')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a miss that normalizes to an empty model id', () => {
    const service = new ModelRouteMissJournalService();

    service.record('models/');
    service.record('   ');

    expect(service.getSnapshot()).toEqual([]);
  });

  it('clears recorded misses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_111);

    try {
      const service = new ModelRouteMissJournalService();

      service.record('models/gemini-3.5-flash');
      service.record('models/claude-3.7-sonnet');
      service.clear();

      expect(service.getSnapshot()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
