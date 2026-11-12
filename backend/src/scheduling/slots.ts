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

/** A time window in minutes after midnight, half-open: [start, end). */
export interface MinuteWindow {
  start: number;
  end: number;
}

/**
 * A working window for one date, with the maximum number of appointments in it. The optional fields come from availability
 * rows (see availability-rules.ts); a session without them is the original kind: slots of the doctor's length, one patient each.
 */
export interface Session {
  startTime: string;
  endTime: string;
  /** STREAM: the most bookings the whole session takes. WAVE: not used to limit anything (each slot has its own capacity). */
  capacity: number;
  source: 'OVERRIDE' | 'ONE_TIME' | 'WEEKLY';
  /** The availability row this session was generated from; null for a date exception. */
  availabilityId?: string | null;
  mode?: 'STREAM' | 'WAVE';
  /** Slot length for this session; defaults to the doctor's consultation length. */
  slotMinutes?: number;
  /** Patients per slot; defaults to 1 and is always 1 for STREAM. */
  capacityPerSlot?: number;
  /** Parts of the session that offer no slots: taken by a higher-priority schedule, or blocked by a partial-day exception. */
  excluded?: MinuteWindow[];
}

export interface SessionSummary extends Session {
  booked: number;
  remaining: number;
}

export interface Slot {
  startTime: string;
  endTime: string;
  status: SlotStatus;
  /** Only on slots that come from an availability row: the patients this slot takes, how many hold it, and how many seats are left. */
  capacityPerSlot?: number;
  booked?: number;
  remaining?: number;
  mode?: 'STREAM' | 'WAVE';
  availabilityId?: string | null;
}

/** The time an active appointment occupies, and (when known) which seat of its slot it holds. */
export interface BookedWindow {
  startTime: string;
  endTime: string;
  slotNumber?: number;
}

/** True when two half-open time ranges [aStart, aEnd) and [bStart, bEnd) share any time. Back-to-back ranges do not overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * How many appointments share time with a slot [from, to): the one definition of "places taken". The slot engine uses it to say
 * what is left, and the capacity rules use it to check a lower capacity against the bookings already made, so the two cannot disagree.
 */
export function placesTaken(windows: { start: number; end: number }[], from: number, to: number): number {
  return windows.filter((window) => overlaps(from, to, window.start, window.end)).length;
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
 * Splits each session into slots and marks each slot.
 *
 * A slot is `session.slotMinutes` long (default: the doctor's appointment length) and takes `session.capacityPerSlot` patients
 * (default 1). A new slot STARTS every `intervalMinutes` for a STREAM session of the doctor's own slot length (default: the
 * appointment length, so slots follow one another). When that interval is shorter than the appointment, slots overlap each other:
 * 30-minute appointments every 15 minutes give 11:00-11:30, 11:15-11:45, 11:30-12:00 and so on. Every other session, and every
 * WAVE session, is cut into back-to-back slots. Only slots that fit entirely inside the session are offered, and none that
 * overlap `session.excluded` (taken by a higher-priority schedule, or blocked).
 *
 * - BOOKED: the slot shares time with as many active appointments as it has seats (one, for STREAM)
 * - PAST:   the slot starts at or before `nowCutoff` (only set for today)
 * - FULL:   a STREAM session has reached its capacity
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
    const length = session.slotMinutes ?? consultationMinutes;
    const seats = session.capacityPerSlot ?? 1;
    const wave = session.mode === 'WAVE';
    const step = !wave && length === consultationMinutes ? Math.max(1, Math.floor(intervalMinutes)) : length;
    const excluded = session.excluded ?? [];
    // An appointment belongs to the session it starts in; that is what counts against the session's capacity.
    const bookedInSession = windows.filter((window) => window.start >= start && window.start < end).length;
    const sessionRemaining = Math.max(session.capacity - bookedInSession, 0);

    const first = slots.length;
    for (let t = start; t + length <= end; t += step) {
      if (excluded.some((window) => overlaps(t, t + length, window.start, window.end))) continue;
      const taken = placesTaken(windows, t, t + length);
      let status: SlotStatus = 'AVAILABLE';
      if (taken >= seats) status = 'BOOKED';
      else if (cutoff !== null && t <= cutoff) status = 'PAST';
      else if (!wave && sessionRemaining === 0) status = 'FULL';
      const slot: Slot = { startTime: fromMinutes(t), endTime: fromMinutes(t + length), status };
      if (session.slotMinutes !== undefined || session.capacityPerSlot !== undefined || session.mode !== undefined) {
        slot.capacityPerSlot = seats;
        slot.booked = Math.min(taken, seats);
        slot.remaining = Math.max(seats - taken, 0);
        slot.mode = session.mode ?? 'STREAM';
        slot.availabilityId = session.availabilityId ?? null;
      }
      slots.push(slot);
    }

    // WAVE sessions are limited slot by slot, so their session total is simply every seat they offer.
    if (wave) {
      const seatsOffered = (slots.length - first) * seats;
      summaries.push({ ...session, capacity: seatsOffered, booked: bookedInSession, remaining: Math.max(seatsOffered - bookedInSession, 0) });
    } else {
      summaries.push({ ...session, booked: bookedInSession, remaining: sessionRemaining });
    }
  }
  // Sessions can interleave (a one-time session inside a longer weekly one), so list the day's slots in time order.
  slots.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime) || toMinutes(a.endTime) - toMinutes(b.endTime));
  return { sessions: summaries, slots };
}

/**
 * The lowest free seat (1..seats) of a slot, or null when the slot is full. A seat is taken by any active appointment that
 * overlaps the slot and holds it; appointments with no known seat count as seat 1 (every appointment made before WAVE did).
 */
export function nextFreeSeat(booked: BookedWindow[], slot: { startTime: string; endTime: string }, seats: number): number | null {
  const start = toMinutes(slot.startTime);
  const end = toMinutes(slot.endTime);
  const taken = new Set(
    booked
      .filter((window) => overlaps(start, end, toMinutes(window.startTime), toMinutes(window.endTime)))
      .map((window) => window.slotNumber ?? 1),
  );
  for (let seat = 1; seat <= seats; seat++) if (!taken.has(seat)) return seat;
  return null;
}
