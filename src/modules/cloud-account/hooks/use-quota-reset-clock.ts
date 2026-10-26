import { useEffect, useState } from 'react';

/** One cancellable timer per section, waking only at a reset boundary; it never fetches quota. */
export function useQuotaResetClock(resetTimes: string[]): number {
  const [now, setNow] = useState(Date.now);
  // A derived boundary avoids rescheduling when callers rebuild equivalent bucket lists.
  const boundaries = resetTimes.map((value) => Date.parse(value)).filter(Number.isFinite);
  const nextReset = boundaries.reduce(
    (next, value) => (value > now ? Math.min(next, value) : next),
    Infinity,
  );

  useEffect(() => {
    if (!Number.isFinite(nextReset)) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const wait = () => {
      // Browsers clamp longer timeouts to an immediate callback. Preserve distant boundaries.
      const delay = Math.min(2_147_483_647, Math.max(0, nextReset - Date.now()));
      timer = setTimeout(() => {
        const current = Date.now();
        if (current < nextReset) {
          // Also retain the timer after clock rollback to the existing React state value.
          wait();
          return;
        }
        setNow(current);
      }, delay);
    };
    wait();
    return () => clearTimeout(timer);
  }, [nextReset, now]);

  return now;
}
