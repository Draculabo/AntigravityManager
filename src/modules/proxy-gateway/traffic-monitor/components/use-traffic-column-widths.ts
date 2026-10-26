import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TrafficClass } from '../../audit/traffic-classifier';

export function clampColumnWidth(width: number): number {
  return Math.min(640, Math.max(45, width));
}

export function readColumnWidths(
  tab: TrafficClass,
  ids: string[],
  defaults: Record<string, number>,
): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`traffic-table-columns:${tab}`) ?? 'null',
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaults;
    }
    return Object.fromEntries(
      ids.map((id) => {
        const value: unknown = Reflect.get(parsed, id);
        return [
          id,
          typeof value === 'number' && Number.isFinite(value)
            ? clampColumnWidth(value)
            : defaults[id],
        ];
      }),
    );
  } catch {
    return defaults;
  }
}

/** Owns the category preference and the global listeners for one active resize. */
export function useTrafficColumnWidths(
  tab: TrafficClass,
  ids: string[],
  defaults: Record<string, number>,
) {
  const [layout, setLayout] = useState(() => ({
    tab,
    widths: readColumnWidths(tab, ids, defaults),
    unsaved: false,
  }));
  const dragCleanup = useRef<(() => void) | null>(null);
  const current = useRef(layout);
  if (layout.tab !== tab) {
    setLayout({ tab, widths: readColumnWidths(tab, ids, defaults), unsaved: false });
  }
  useLayoutEffect(() => {
    current.current = layout;
  }, [layout]);
  useEffect(
    () => () => {
      dragCleanup.current?.();
    },
    [tab],
  );

  function save(widths: Record<string, number>, reset = false) {
    let unsaved = false;
    try {
      if (reset) {
        localStorage.removeItem(`traffic-table-columns:${tab}`);
      } else {
        localStorage.setItem(`traffic-table-columns:${tab}`, JSON.stringify(widths));
      }
    } catch {
      // Storage denial must not prevent a local resize or claim it was saved.
      unsaved = true;
    }
    const next = { tab, widths, unsaved };
    current.current = next;
    setLayout(next);
  }
  function resize(id: string, delta: number) {
    save({ ...current.current.widths, [id]: clampColumnWidth(current.current.widths[id] + delta) });
  }
  function startDrag(id: string, startX: number, pointerId: number) {
    dragCleanup.current?.();
    const startWidth = current.current.widths[id];
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointerId) {
        save({
          ...current.current.widths,
          [id]: clampColumnWidth(startWidth + event.clientX - startX),
        });
      }
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId === pointerId) {
        stop();
      }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', stop);
      dragCleanup.current = null;
    };
    dragCleanup.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', stop);
  }
  return {
    widths: layout.widths,
    unsaved: layout.unsaved,
    resize,
    startDrag,
    reset: () => {
      dragCleanup.current?.();
      save(defaults, true);
    },
  };
}
