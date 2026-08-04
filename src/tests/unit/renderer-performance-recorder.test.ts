import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRendererPerformanceRecorder } from '@/tests/performance/support/renderer-recorder';

interface TestEventPerformanceEntry extends PerformanceEntry {
  interactionId: number;
  processingEnd: number;
  processingStart: number;
}

function createPerformanceEntry(
  entryType: string,
  name: string,
  startTime: number,
  duration: number,
): PerformanceEntry {
  return {
    duration,
    entryType,
    name,
    startTime,
    toJSON: () => ({ duration, entryType, name, startTime }),
  };
}

function createEventEntry(startTime: number): TestEventPerformanceEntry {
  return {
    ...createPerformanceEntry('event', 'click', startTime, 24),
    interactionId: startTime,
    processingEnd: startTime + 20,
    processingStart: startTime + 4,
  };
}

class FakePerformanceObserver implements PerformanceObserver {
  static readonly supportedEntryTypes = ['event', 'longtask'];

  constructor(private readonly callback: PerformanceObserverCallback) {}

  disconnect(): void {}

  observe(options: PerformanceObserverInit): void {
    const entries =
      options.type === 'longtask'
        ? [
            createPerformanceEntry('longtask', 'historical', 100, 250),
            createPerformanceEntry('longtask', 'recorded', 1_000, 50),
          ]
        : [createEventEntry(200), createEventEntry(1_100)];
    const entryList: PerformanceObserverEntryList = {
      getEntries: () => entries,
      getEntriesByName: (name, type) =>
        entries.filter((entry) => entry.name === name && (!type || entry.entryType === type)),
      getEntriesByType: (type) => entries.filter((entry) => entry.entryType === type),
    };
    this.callback(entryList, this);
  }

  takeRecords(): PerformanceEntryList {
    return [];
  }
}

describe('renderer performance recorder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('excludes entries captured before the recording window', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
    const recorder = createRendererPerformanceRecorder();
    recorder.start();
    const snapshot = recorder.stop();

    expect(snapshot).toMatchObject({
      events: [expect.objectContaining({ startTimeMs: 1_100 })],
      longTasks: [expect.objectContaining({ name: 'recorded', startTimeMs: 1_000 })],
    });
  });
});
