const DAY_MS = 86_400_000;

/** Today as 'YYYY-MM-DD', in local time. */
export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Whole days from `now` to the date: 0 = today, negative = in the past. */
export function daysUntil(date: string, now: Date): number {
  const [y, m, d] = date.split('-').map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / DAY_MS);
}

export function addDays(now: Date, days: number): string {
  return toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** "in 12 days", "today", "3 days ago". */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  const n = Math.abs(days);
  const unit = n === 1 ? 'day' : 'days';
  return days > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}
