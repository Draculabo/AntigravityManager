import type {
  RendererEventTimingEntry,
  RendererPerformanceRecorderController,
  RendererPerformanceSnapshot,
} from '@/modules/app-shell/performance-recorder/types';

/**
 * Create a renderer-side recorder whose entire implementation can be serialized into the page by
 * Playwright. Keeping every runtime dependency inside the factory prevents performance tests from
 * adding hooks or globals to the product renderer entry point.
 */
export function createRendererPerformanceRecorder(): RendererPerformanceRecorderController {
  const MAX_RENDERER_ENTRIES = 20_000;
  const RECORDED_EVENT_NAMES = new Set([
    'auxclick',
    'click',
    'contextmenu',
    'dblclick',
    'keydown',
    'mousedown',
    'pointerdown',
    'pointerup',
    'touchend',
    'touchstart',
  ]);

  interface EventTimingPerformanceEntry extends PerformanceEntry {
    interactionId?: number;
    processingEnd: number;
    processingStart: number;
    target?: EventTarget | null;
  }

  interface EventPerformanceObserverInit extends PerformanceObserverInit {
    durationThreshold: number;
  }

  interface ActivePerformanceObserver {
    observer: PerformanceObserver;
    record: (entries: PerformanceEntry[]) => void;
  }

  function isEventTimingEntry(entry: PerformanceEntry): entry is EventTimingPerformanceEntry {
    return 'processingStart' in entry && 'processingEnd' in entry;
  }

  function getTargetMetadata(target: EventTarget | null | undefined): {
    targetAriaLabel?: string;
    targetTag?: string;
  } {
    if (!(target instanceof Element)) {
      return {};
    }

    const targetAriaLabel = target.getAttribute('aria-label')?.slice(0, 128);
    return {
      ...(targetAriaLabel ? { targetAriaLabel } : {}),
      targetTag: target.tagName.toLowerCase(),
    };
  }

  class RendererPerformanceRecorder implements RendererPerformanceRecorderController {
    private events: RendererEventTimingEntry[] = [];
    private longTasks: RendererPerformanceSnapshot['longTasks'] = [];
    private observers: ActivePerformanceObserver[] = [];
    private recordingStartedAtMs = 0;

    start(): void {
      this.disconnect();
      this.events = [];
      this.longTasks = [];
      this.recordingStartedAtMs = performance.now();

      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        const recordLongTasks = (entries: PerformanceEntry[]) => {
          for (const entry of entries) {
            if (this.longTasks.length >= MAX_RENDERER_ENTRIES) {
              break;
            }
            if (entry.startTime < this.recordingStartedAtMs) {
              continue;
            }
            this.longTasks.push({
              durationMs: entry.duration,
              name: entry.name.slice(0, 256),
              startTimeMs: entry.startTime,
            });
          }
        };
        const longTaskObserver = new PerformanceObserver((list) => {
          recordLongTasks(list.getEntries());
        });
        longTaskObserver.observe({ buffered: false, type: 'longtask' });
        this.observers.push({ observer: longTaskObserver, record: recordLongTasks });
      }

      if (PerformanceObserver.supportedEntryTypes.includes('event')) {
        const recordEvents = (entries: PerformanceEntry[]) => {
          for (const entry of entries) {
            if (
              this.events.length >= MAX_RENDERER_ENTRIES ||
              entry.startTime < this.recordingStartedAtMs ||
              !RECORDED_EVENT_NAMES.has(entry.name) ||
              !isEventTimingEntry(entry)
            ) {
              continue;
            }
            this.events.push({
              durationMs: entry.duration,
              interactionId: entry.interactionId,
              name: entry.name.slice(0, 128),
              processingEndMs: entry.processingEnd,
              processingStartMs: entry.processingStart,
              startTimeMs: entry.startTime,
              ...getTargetMetadata(entry.target),
            });
          }
        };
        const eventObserver = new PerformanceObserver((list) => {
          recordEvents(list.getEntries());
        });
        const eventObserverOptions: EventPerformanceObserverInit = {
          buffered: false,
          durationThreshold: 16,
          type: 'event',
        };
        eventObserver.observe(eventObserverOptions);
        this.observers.push({ observer: eventObserver, record: recordEvents });
      }
    }

    stop(): RendererPerformanceSnapshot {
      for (const { observer, record } of this.observers) {
        record(observer.takeRecords());
      }
      this.disconnect();

      return {
        capturedAt: new Date().toISOString(),
        events: [...this.events],
        longTasks: [...this.longTasks],
        timeOrigin: performance.timeOrigin,
      };
    }

    private disconnect(): void {
      for (const { observer } of this.observers) {
        observer.disconnect();
      }
      this.observers = [];
    }
  }

  return new RendererPerformanceRecorder();
}
