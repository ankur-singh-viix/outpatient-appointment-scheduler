// Pure rules (no database) that turn a doctor's availability rows and date exception into the sessions of one date.
// See docs/scheduling.md for the definitions this implements.

import { dayOfWeek } from './calendar.js';
import { hhmm, overlaps, toMinutes, type DateOverride, type MinuteWindow, type Session } from './slots.js';

/** One availability row, as the rules see it. */
export interface AvailabilityRule {
  id: string | null;
  recurrenceType: 'WEEKLY' | 'ONE_TIME';
  /** 0 = Sunday ... 6 = Saturday. WEEKLY only. */
  dayOfWeek: number | null;
  /** YYYY-MM-DD. ONE_TIME only. */
  specificDate: string | null;
  startTime: string;
  endTime: string;
  /** STREAM: cap on bookings in the whole session (null: the doctor's default). WAVE: ignored. */
  capacity: number | null;
  schedulingMode: 'STREAM' | 'WAVE';
  /** Null: the doctor's consultation length. */
  slotDurationMinutes: number | null;
  capacityPerSlot: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface DoctorDefaults {
  consultationMinutes: number;
  defaultCapacity: number;
}

/** True when the row applies on `date`: it repeats on that weekday (or is set for exactly that date) and the date is in its effective range. */
export function appliesOn(rule: AvailabilityRule, date: string): boolean {
  if (rule.effectiveFrom !== null && date < rule.effectiveFrom) return false;
  if (rule.effectiveTo !== null && date > rule.effectiveTo) return false;
  return rule.recurrenceType === 'ONE_TIME' ? rule.specificDate === date : rule.dayOfWeek === dayOfWeek(date);
}

function windowOf(session: Pick<Session, 'startTime' | 'endTime'>): MinuteWindow {
  return { start: toMinutes(session.startTime), end: toMinutes(session.endTime) };
}

/**
 * The sessions of the date's ONE_TIME and WEEKLY rows, in priority order: ONE_TIME before WEEKLY, and inside each kind the earlier
 * start first (then by id, so the order never depends on how the database returned the rows). Each session lists, in `excluded`,
 * the parts of its window already claimed by a session before it, so where two rows overlap the higher-priority one wins that time
 * and the lower one simply offers no slots there. Slots outside the overlap are untouched.
 */
function layeredSessions(rules: AvailabilityRule[], date: string, doctor: DoctorDefaults): Session[] {
  const rank = (rule: AvailabilityRule) => (rule.recurrenceType === 'ONE_TIME' ? 0 : 1);
  const ordered = rules
    .filter((rule) => appliesOn(rule, date))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        toMinutes(a.startTime) - toMinutes(b.startTime) ||
        toMinutes(a.endTime) - toMinutes(b.endTime) ||
        (a.id ?? '').localeCompare(b.id ?? ''),
    );

  const sessions: Session[] = [];
  for (const rule of ordered) {
    const session: Session = {
      startTime: hhmm(rule.startTime),
      endTime: hhmm(rule.endTime),
      capacity: rule.capacity ?? doctor.defaultCapacity,
      source: rule.recurrenceType === 'ONE_TIME' ? 'ONE_TIME' : 'WEEKLY',
      availabilityId: rule.id,
      mode: rule.schedulingMode,
      slotMinutes: rule.slotDurationMinutes ?? doctor.consultationMinutes,
      // STREAM always takes one patient per slot, whatever the row says.
      capacityPerSlot: rule.schedulingMode === 'STREAM' ? 1 : rule.capacityPerSlot,
    };
    const mine = windowOf(session);
    const taken = sessions.map(windowOf).filter((other) => overlaps(mine.start, mine.end, other.start, other.end));
    if (taken.length > 0) session.excluded = taken;
    sessions.push(session);
  }
  return sessions;
}

/**
 * What a date exception inherits when it replaces the day: the slot length, mode and capacity per slot of the first session the
 * day would otherwise have had (so a clinic that runs WAVE keeps running WAVE on a day with different hours). With no such
 * session it is a STREAM session of the doctor's own slot length.
 */
export function inheritedSettings(
  rules: AvailabilityRule[],
  date: string,
  doctor: DoctorDefaults,
): { mode: 'STREAM' | 'WAVE'; slotMinutes: number; capacityPerSlot: number } {
  const first = layeredSessions(rules, date, doctor)[0];
  return {
    mode: first?.mode ?? 'STREAM',
    slotMinutes: first?.slotMinutes ?? doctor.consultationMinutes,
    capacityPerSlot: first?.capacityPerSlot ?? 1,
  };
}

/**
 * The working sessions for one date. Priority, highest first:
 *
 *  1. A date exception (schedule override).
 *     - Available: replaces the whole day with its own window (as it always has). It inherits slot length, mode and capacity per
 *       slot from the day's normal schedule; its `capacity` is the session cap for STREAM.
 *     - Unavailable with no times: a day off, no sessions.
 *     - Unavailable with a start and end: blocks only that window. Everything else the day would have had still applies, but no
 *       slot overlapping the blocked window is offered.
 *  2. ONE_TIME availability for the date.
 *  3. WEEKLY availability for the weekday.
 *
 * Between 2 and 3, and between rows of the same kind, a higher priority wins only the time it actually overlaps.
 * Rows outside their effective range are ignored.
 */
export function resolveDay(
  override: DateOverride | null,
  rules: AvailabilityRule[],
  date: string,
  doctor: DoctorDefaults,
): Session[] {
  if (override && !override.isAvailable) {
    if (!override.startTime || !override.endTime) return [];
    const blocked: MinuteWindow = { start: toMinutes(override.startTime), end: toMinutes(override.endTime) };
    return chronological(layeredSessions(rules, date, doctor).map((session) => ({ ...session, excluded: [...(session.excluded ?? []), blocked] })));
  }
  if (override) {
    if (!override.startTime || !override.endTime) return [];
    const inherited = inheritedSettings(rules, date, doctor);
    return [
      {
        startTime: hhmm(override.startTime),
        endTime: hhmm(override.endTime),
        capacity: override.capacity ?? doctor.defaultCapacity,
        source: 'OVERRIDE',
        availabilityId: null,
        mode: inherited.mode,
        slotMinutes: inherited.slotMinutes,
        capacityPerSlot: inherited.capacityPerSlot,
      },
    ];
  }
  return chronological(layeredSessions(rules, date, doctor));
}

/** Sessions in the order of the day. Priority only decides who wins an overlap (see `excluded`); it must not decide how slots are listed. */
const chronological = (sessions: Session[]) => [...sessions].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime) || toMinutes(a.endTime) - toMinutes(b.endTime));

/** True when two rows' effective date ranges share at least one day (an open end reaches as far as needed). */
export function effectiveRangesIntersect(
  a: { effectiveFrom: string | null; effectiveTo: string | null },
  b: { effectiveFrom: string | null; effectiveTo: string | null },
): boolean {
  const aStartsBeforeBEnds = a.effectiveFrom === null || b.effectiveTo === null || a.effectiveFrom <= b.effectiveTo;
  const bStartsBeforeAEnds = b.effectiveFrom === null || a.effectiveTo === null || b.effectiveFrom <= a.effectiveTo;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/** What is wrong with one row's own values, or null when it is fine. Used before anything is saved. */
export function ruleProblem(rule: {
  recurrenceType: 'WEEKLY' | 'ONE_TIME';
  dayOfWeek: number | null;
  specificDate: string | null;
  startTime: string;
  endTime: string;
  schedulingMode: 'STREAM' | 'WAVE';
  slotDurationMinutes: number;
  capacityPerSlot: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}): string | null {
  if (rule.recurrenceType === 'WEEKLY') {
    if (rule.dayOfWeek === null) return 'dayOfWeek is required for WEEKLY availability.';
    if (rule.specificDate !== null) return 'specificDate must not be set for WEEKLY availability.';
  } else {
    if (rule.specificDate === null) return 'specificDate is required for ONE_TIME availability.';
    if (rule.dayOfWeek !== null) return 'dayOfWeek must not be set for ONE_TIME availability.';
  }
  const length = toMinutes(rule.endTime) - toMinutes(rule.startTime);
  if (length <= 0) return 'endTime must be after startTime.';
  if (rule.slotDurationMinutes <= 0) return 'slotDurationMinutes must be greater than 0.';
  if (length < rule.slotDurationMinutes) return `The window must be at least ${rule.slotDurationMinutes} minutes long, to fit one slot.`;
  if (rule.capacityPerSlot <= 0) return 'capacityPerSlot must be greater than 0.';
  if (rule.schedulingMode === 'STREAM' && rule.capacityPerSlot !== 1) return 'STREAM scheduling takes exactly one patient per slot (capacityPerSlot must be 1).';
  if (rule.effectiveFrom !== null && rule.effectiveTo !== null && rule.effectiveTo < rule.effectiveFrom) return 'effectiveTo must not be before effectiveFrom.';
  return null;
}
