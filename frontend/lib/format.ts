import { CLINIC_TIMEZONE } from './config';
import type { WeeklyWindow } from './types';

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Display order for weekly schedules: Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export function formatFee(amount: number): string {
  return inr.format(amount);
}

/** "14:30" -> "2:30 PM" */
export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** "2026-10-29" -> "Thu, 29 Oct 2026" */
export function formatDate(date: string, options: Intl.DateTimeFormatOptions = {}): string {
  return parseDate(date).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
    ...options,
  });
}

export function dayOfWeek(date: string): number {
  return parseDate(date).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date in the clinic time zone, as YYYY-MM-DD. */
export function clinicToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Summarises weekly hours, grouping days with identical timings:
 * ["Mon–Fri · 9:00 AM–1:00 PM", "Sat · 10:00 AM–12:00 PM"].
 */
export function summariseWeeklyHours(hours: WeeklyWindow[]): string[] {
  const byDay = new Map<number, string>();
  for (const day of WEEK_ORDER) {
    const windows = hours
      .filter((h) => h.dayOfWeek === day)
      .map((h) => `${formatTime(h.startTime)}–${formatTime(h.endTime)}`);
    if (windows.length) byDay.set(day, windows.join(', '));
  }

  const lines: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const label =
      run.length > 2 ? `${DAY_SHORT[run[0]]}–${DAY_SHORT[run[run.length - 1]]}` : run.map((d) => DAY_SHORT[d]).join(', ');
    lines.push(`${label} · ${byDay.get(run[0])}`);
    run = [];
  };
  for (let i = 0; i < WEEK_ORDER.length; i++) {
    const day = WEEK_ORDER[i];
    const timing = byDay.get(day);
    const prev = run.length ? byDay.get(run[run.length - 1]) : undefined;
    const consecutive = run.length > 0 && WEEK_ORDER.indexOf(run[run.length - 1]) === i - 1;
    if (timing && timing === prev && consecutive) {
      run.push(day);
    } else {
      flush();
      if (timing) run.push(day);
    }
  }
  flush();
  return lines;
}

export function initials(name: string): string {
  return name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
