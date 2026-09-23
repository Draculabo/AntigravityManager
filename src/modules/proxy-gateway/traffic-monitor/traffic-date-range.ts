import { format } from 'date-fns';

export function toLocalDate(timestamp: number | undefined): string {
  if (timestamp === undefined) {
    return '';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return format(date, 'yyyy-MM-dd');
}

export function dateBoundary(value: string, endOfDay: boolean): number | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
}
