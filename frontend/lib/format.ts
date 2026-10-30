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

const inrExact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Money held in paise (1/100 rupee), shown exactly: 32500 -> "₹325", 32550 -> "₹325.50". */
export function formatPaise(paise: number): string {
  return inrExact.format(paise / 100);
}

/**
 * A start and end time as one range: "11:00 AM – 11:30 AM". With `compact`, the AM/PM is written once when both ends share it
 * ("11:00 – 11:30 AM"), which is what fits inside a slot button.
 */
export function formatTimeRange(start: string, end: string, compact = false): string {
  const from = formatTime(start);
  const to = formatTime(end);
  if (compact && from.slice(-2) === to.slice(-2)) return `${from.slice(0, -3)} – ${to}`;
  return `${from} – ${to}`;
}

/** An instant (ISO timestamp) in clinic time: "29 Oct 2026, 2:30 pm". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: CLINIC_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
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

/** The date and time of day (HH:MM) in the clinic time zone at the given moment. */
export function clinicClock(nowMs: number): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: CLINIC_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(nowMs))
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "Today" or "Tomorrow" for the two nearest days, otherwise null. */
export function relativeDay(date: string, today: string | null): string | null {
  if (!today) return null;
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return null;
}

/** "just now", "5 min ago", "3 h ago" or "2 d ago", for an ISO timestamp. */
export function timeAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
