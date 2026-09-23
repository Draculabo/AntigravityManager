import { format } from 'date-fns';

/** Display audit timestamps in the user's local time without changing stored UTC values. */
export function formatTrafficTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'yyyy-MM-dd HH:mm:ss');
}
