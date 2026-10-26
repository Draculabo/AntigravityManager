import type { TrafficClass } from './traffic-classifier';

export type AuditGenerationSnapshot = Record<TrafficClass, number>;
export function initialAuditGenerations(): AuditGenerationSnapshot {
  return { model: 0, auxiliary: 0, ipc: 0, system: 0 };
}
export const AUDIT_TRAFFIC_CLASSES = ['model', 'auxiliary', 'ipc', 'system'] as const;

/** Process-local capture lifetime; WeakMap entries disappear with their request handles. */
export class AuditCaptureGenerations {
  private readonly values = initialAuditGenerations();
  private readonly barriers = initialAuditGenerations();
  private readonly handles = new WeakMap<object, number>();

  current(trafficClass: TrafficClass): number {
    return this.values[trafficClass];
  }
  accepts(trafficClass: TrafficClass, generation: number): boolean {
    return this.barriers[trafficClass] === 0 && generation === this.values[trafficClass];
  }
  track<T extends { trafficClass: TrafficClass }>(handle: T): T {
    this.handles.set(handle, this.current(handle.trafficClass));
    return handle;
  }
  isCurrent(handle: { trafficClass: TrafficClass }): boolean {
    return this.accepts(handle.trafficClass, this.handles.get(handle) ?? 0);
  }
  beginClear(trafficClass: TrafficClass | null) {
    const affected = trafficClass ? [trafficClass] : AUDIT_TRAFFIC_CLASSES;
    for (const scope of affected) {
      this.values[scope] += 1;
      this.barriers[scope] += 1;
    }
    let finished = false;
    return {
      generations: { ...this.values },
      finish: () => {
        if (finished) {
          return;
        }
        finished = true;
        for (const scope of affected) {
          this.barriers[scope] -= 1;
        }
      },
    };
  }
}
