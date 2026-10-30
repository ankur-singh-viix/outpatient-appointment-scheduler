// Pure scheduling rules (no database), shared by slot listing and booking so
// what a patient is shown is exactly what the server enforces.

export type SlotStatus = 'AVAILABLE' | 'BOOKED' | 'FULL' | 'PAST';

export interface WeeklyHours {
  startTime: string;
  endTime: string;
  capacity: number;
}

export interface DateOverride {
  isAvailable: boolean;
  startTime: string | null;
  endTime: string | null;
  capacity: number | null;
  reason: string | null;
}

/** A working window for one date, with the maximum number of appointments in it. */
export interface Session {
  startTime: string;
  endTime: string;
  capacity: number;
  source: 'OVERRIDE' | 'WEEKLY';
}

export interface SessionSummary extends Session {
  booked: number;
  remaining: number;
}

export interface Slot {
  startTime: string;
  endTime: string;
  status: SlotStatus;
}

/** The time an active appointment occupies. */
export interface BookedWindow {
  startTime: string;
  endTime: string;
}

/** True when two half-open time ranges [aStart, aEnd) and [bStart, bEnd) share any time. Back-to-back ranges do not overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** "09:30" or "09:30:00" -> minutes after midnight. */
export function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minutes after midnight -> "HH:MM". */
export function fromMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Normalises "09:30:00" to "09:30". */
export function hhmm(time: string): string {
  return time.slice(0, 5);
}

/**
 * Working sessions for one date, applying the capacity rules from the ER design:
 * a date override wins over the weekly schedule; a day off means no sessions;
 * a missing capacity falls back to the doctor's default.
 */
export function resolveSessions(
  override: DateOverride | null,
  weekly: WeeklyHours[],
  defaultCapacity: number,
): Session[] {
  if (override) {
    if (!override.isAvailable || !override.startTime || !override.endTime) return [];
    return [
      {
        startTime: hhmm(override.startTime),
        endTime: hhmm(override.endTime),
        capacity: override.capacity ?? defaultCapacity,
        source: 'OVERRIDE',
      },
    ];
  }
  return weekly
    .map((hours) => ({
      startTime: hhmm(hours.startTime),
      endTime: hhmm(hours.endTime),
      capacity: hours.capacity ?? defaultCapacity,
      source: 'WEEKLY' as const,
    }))
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
}

/**
 * Splits each session into appointment-length slots (STREAM scheduling) and marks each slot.
 *
 * A new slot STARTS every `intervalMinutes` (default: the appointment length, so slots follow one another). When the interval is
 * shorter than the appointment, slots overlap each other: 30-minute appointments every 15 minutes give 11:00-11:30, 11:15-11:45,
 * 11:30-12:00 and so on. Only appointments that fit entirely inside the session are offered.
 *
 * - BOOKED: the slot shares any time with an active appointment (so a booking blocks every overlapping window, not just its own)
 * - FULL:   the session has reached its capacity
 * - PAST:   the slot starts at or before `nowCutoff` (only set for today)
 *
 * `booked` entries are full windows, or just start times, which stand for one appointment length starting then.
 */
export function buildSlots(
  sessions: Session[],
  consultationMinutes: number,
  booked: (string | BookedWindow)[],
  nowCutoff: string | null,
  intervalMinutes: number = consultationMinutes,
): { sessions: SessionSummary[]; slots: Slot[] } {
  const step = Math.max(1, Math.floor(intervalMinutes));
  const windows = booked.map((entry) =>
    typeof entry === 'string'
      ? { start: toMinutes(entry), end: toMinutes(entry) + consultationMinutes }
      : { start: toMinutes(entry.startTime), end: toMinutes(entry.endTime) },
  );
  const cutoff = nowCutoff === null ? null : toMinutes(nowCutoff);
  const summaries: SessionSummary[] = [];
  const slots: Slot[] = [];

  for (const session of sessions) {
    const start = toMinutes(session.startTime);
    const end = toMinutes(session.endTime);
    // An appointment belongs to the session it starts in; that is what counts against the session's capacity.
    const bookedInSession = windows.filter((window) => window.start >= start && window.start < end).length;
    const remaining = Math.max(session.capacity - bookedInSession, 0);
    summaries.push({ ...session, booked: bookedInSession, remaining });

    for (let t = start; t + consultationMinutes <= end; t += step) {
      const startTime = fromMinutes(t);
      let status: SlotStatus = 'AVAILABLE';
      if (windows.some((window) => overlaps(t, t + consultationMinutes, window.start, window.end))) status = 'BOOKED';
      else if (cutoff !== null && t <= cutoff) status = 'PAST';
      else if (remaining === 0) status = 'FULL';
      slots.push({ startTime, endTime: fromMinutes(t + consultationMinutes), status });
    }
  }
  return { sessions: summaries, slots };
}
