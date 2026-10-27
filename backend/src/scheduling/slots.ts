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
 * Splits each session into consultation-length slots (STREAM scheduling) and marks each slot:
 * - BOOKED: an active appointment already starts at that time
 * - FULL:   the session has reached its capacity
 * - PAST:   the slot starts at or before `nowCutoff` (only set for today)
 */
export function buildSlots(
  sessions: Session[],
  consultationMinutes: number,
  bookedStartTimes: string[],
  nowCutoff: string | null,
): { sessions: SessionSummary[]; slots: Slot[] } {
  const booked = new Set(bookedStartTimes.map(hhmm));
  const cutoff = nowCutoff === null ? null : toMinutes(nowCutoff);
  const summaries: SessionSummary[] = [];
  const slots: Slot[] = [];

  for (const session of sessions) {
    const start = toMinutes(session.startTime);
    const end = toMinutes(session.endTime);
    const bookedInSession = [...booked].filter((time) => {
      const minutes = toMinutes(time);
      return minutes >= start && minutes < end;
    }).length;
    const remaining = Math.max(session.capacity - bookedInSession, 0);
    summaries.push({ ...session, booked: bookedInSession, remaining });

    for (let t = start; t + consultationMinutes <= end; t += consultationMinutes) {
      const startTime = fromMinutes(t);
      let status: SlotStatus = 'AVAILABLE';
      if (booked.has(startTime)) status = 'BOOKED';
      else if (cutoff !== null && t <= cutoff) status = 'PAST';
      else if (remaining === 0) status = 'FULL';
      slots.push({ startTime, endTime: fromMinutes(t + consultationMinutes), status });
    }
  }
  return { sessions: summaries, slots };
}
