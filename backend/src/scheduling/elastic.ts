// Pure rules (no database) for changing the hours of an existing availability row ("elastic scheduling"). They reuse the same
// engine patients are offered slots from (resolveDay + buildSlots), run once with the current rules and once with the proposed
// ones, so a preview can only ever show what booking would really do.

import { addDays } from './calendar.js';
import { appliesOn, effectiveRangesIntersect, resolveDay, type AvailabilityRule } from './availability-rules.js';
import { buildSlots, fromMinutes, hhmm, overlaps, toMinutes, type BookedWindow, type DateOverride, type Session } from './slots.js';

export interface Window {
  startTime: string;
  endTime: string;
}

export type ChangeKind = 'EXPAND' | 'SHRINK' | 'MIXED' | 'NONE';

export interface ElasticDoctor {
  consultationMinutes: number;
  defaultCapacity: number;
  /** Minutes between slot starts for sessions of the doctor's own length (equals consultationMinutes unless an interval was chosen). */
  slotIntervalMinutes: number;
}

/** How far apart a row's slots start. Same rule buildSlots uses, so alignment checks agree with the slots patients see. */
export function slotStep(rule: Pick<AvailabilityRule, 'schedulingMode' | 'slotDurationMinutes'>, doctor: ElasticDoctor): number {
  const length = rule.slotDurationMinutes ?? doctor.consultationMinutes;
  return rule.schedulingMode !== 'WAVE' && length === doctor.consultationMinutes ? Math.max(1, Math.floor(doctor.slotIntervalMinutes)) : length;
}

/** Whether the proposed window grows the current one, shrinks it, does both (one side each way) or changes nothing. */
export function classify(current: Window, proposed: Window): ChangeKind {
  const grows = toMinutes(proposed.startTime) < toMinutes(current.startTime) || toMinutes(proposed.endTime) > toMinutes(current.endTime);
  const shrinks = toMinutes(proposed.startTime) > toMinutes(current.startTime) || toMinutes(proposed.endTime) < toMinutes(current.endTime);
  return grows && shrinks ? 'MIXED' : grows ? 'EXPAND' : shrinks ? 'SHRINK' : 'NONE';
}

/** The two start times nearest a wanted one that keep the existing slot grid (the slots start `step` minutes apart from `anchor`). */
export function alignedStarts(anchor: string, wanted: string, step: number): string[] {
  const from = toMinutes(anchor);
  const steps = (from - toMinutes(wanted)) / step; // positive: earlier than the anchor
  const candidates = new Set([Math.floor(steps), Math.ceil(steps)].map((k) => from - k * step));
  return [...candidates].filter((minutes) => minutes >= 0 && minutes < 24 * 60).sort((a, b) => a - b).map(fromMinutes);
}

/** The slots a doctor offers on one date for these rules and exception, with nothing booked. */
export function slotsOn(date: string, rules: AvailabilityRule[], override: DateOverride | null, doctor: ElasticDoctor) {
  const sessions = resolveDay(override, rules, date, { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultCapacity });
  return { sessions, slots: buildSlots(sessions, doctor.consultationMinutes, [], null, doctor.slotIntervalMinutes).slots };
}

/**
 * True when an appointment sits inside the doctor's working time on its date: inside some session, and clear of any part of it
 * that is blocked or taken by a higher-priority session. This is deliberately about the hours, not about the slot grid: changing
 * the slot interval, which has never moved appointments, must not make anyone "outside the hours".
 */
export function isCovered(sessions: Session[], start: string, end: string): boolean {
  const from = toMinutes(start);
  const to = toMinutes(end);
  return sessions.some(
    (session) => toMinutes(session.startTime) <= from && to <= toMinutes(session.endTime) && !(session.excluded ?? []).some((window) => overlaps(from, to, window.start, window.end)),
  );
}

export interface Range {
  startTime: string;
  endTime: string;
}

export interface DayEffect {
  date: string;
  added: Range[];
  removed: Range[];
}

export interface ChangePlan {
  kind: ChangeKind;
  /** Reasons the change cannot be made, in plain language. Empty when it can. */
  problems: string[];
  /** Start times that would keep the slot grid, offered when the wanted one does not. */
  suggestedStarts: string[];
  /** Every date in the range where the doctor's slots change, with the slots that appear and disappear. */
  days: DayEffect[];
  addedSlots: number;
  removedSlots: number;
}

const key = (range: Range) => `${range.startTime}-${range.endTime}`;

/**
 * Works out what changing one row's window does, date by date, from `applyFrom` to `lastDate`: which slots appear, which
 * disappear, and why the change is refused if it is. Dates that have a date exception (a day off, a blocked time or replacement
 * hours) come out unchanged on their own, because the exception decides those days before the row is consulted.
 */
export function planChange(args: {
  row: AvailabilityRule;
  proposed: Window;
  rules: AvailabilityRule[];
  overrides: Map<string, DateOverride>;
  doctor: ElasticDoctor;
  applyFrom: string;
  lastDate: string;
}): ChangePlan {
  const { row, rules, doctor, overrides } = args;
  const current: Window = { startTime: hhmm(row.startTime), endTime: hhmm(row.endTime) };
  const proposed: Window = { startTime: hhmm(args.proposed.startTime), endTime: hhmm(args.proposed.endTime) };
  const kind = classify(current, proposed);
  const problems: string[] = [];
  let suggestedStarts: string[] = [];

  const length = row.slotDurationMinutes ?? doctor.consultationMinutes;
  const step = slotStep(row, doctor);
  if (toMinutes(proposed.endTime) <= toMinutes(proposed.startTime)) problems.push('The end time must be after the start time.');
  else if (toMinutes(proposed.endTime) - toMinutes(proposed.startTime) < length) problems.push(`The hours must be at least ${length} minutes long, to fit one slot.`);

  // Moving the start moves where the slot grid begins. Only whole steps keep every existing slot exactly where it is.
  const startMove = toMinutes(proposed.startTime) - toMinutes(current.startTime);
  if (startMove !== 0 && Math.abs(startMove) % step !== 0) {
    suggestedStarts = alignedStarts(current.startTime, proposed.startTime, step).filter((start) => start !== proposed.startTime);
    problems.push(
      `The start time has to move in steps of ${step} minutes, so every existing slot stays where it is.${suggestedStarts.length ? ` Try ${suggestedStarts.join(' or ')}.` : ''}`,
    );
  }

  // The new hours must not run into another session of the same kind on the same weekday or date.
  const clash = rules.find(
    (other) =>
      other.id !== row.id &&
      other.recurrenceType === row.recurrenceType &&
      (row.recurrenceType === 'WEEKLY' ? other.dayOfWeek === row.dayOfWeek : other.specificDate === row.specificDate) &&
      effectiveRangesIntersect(row, other) &&
      toMinutes(proposed.startTime) < toMinutes(other.endTime) &&
      toMinutes(other.startTime) < toMinutes(proposed.endTime),
  );
  if (clash) problems.push(`These hours would overlap another session (${hhmm(clash.startTime)}-${hhmm(clash.endTime)}).`);

  const days: DayEffect[] = [];
  let addedSlots = 0;
  let removedSlots = 0;
  if (problems.length === 0 && kind !== 'NONE') {
    const after = rules.map((rule) => (rule.id === row.id ? { ...rule, ...proposed } : rule));
    for (let date = args.applyFrom; date <= args.lastDate; date = addDays(date, 1)) {
      if (!appliesOn(row, date)) continue;
      const override = overrides.get(date) ?? null;
      const was = slotsOn(date, rules, override, doctor).slots.map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime }));
      const will = slotsOn(date, after, override, doctor).slots.map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime }));
      const wasKeys = new Set(was.map(key));
      const willKeys = new Set(will.map(key));
      const added = will.filter((slot) => !wasKeys.has(key(slot)));
      const removed = was.filter((slot) => !willKeys.has(key(slot)));
      if (added.length || removed.length) days.push({ date, added, removed });
      addedSlots += added.length;
      removedSlots += removed.length;
    }
    // Growing changed no date: the row applies on some dates in range, but the extra time is shorter than one slot.
    if (kind === 'EXPAND' && days.length === 0 && datesWhereApplies(row, args.applyFrom, args.lastDate) > 0) {
      problems.push(`The extra time is shorter than one ${length}-minute slot, so no new slots would be created.`);
    }
  }
  return { kind, problems, suggestedStarts, days, addedSlots, removedSlots };
}

function datesWhereApplies(row: AvailabilityRule, from: string, last: string): number {
  let count = 0;
  for (let date = from; date <= last; date = addDays(date, 1)) if (appliesOn(row, date)) count++;
  return count;
}

/** Where an appointment sits. */
export interface Placed {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
}

/**
 * The appointments a set of hours would leave outside the doctor's working time: inside it with the current rules, outside it with
 * the proposed ones. An appointment that was already outside the hours before is not blamed on this change. Dates with a date
 * exception come out unaffected on their own, because the exception decides those days.
 */
export function findAffected(args: { appointments: Placed[]; rules: AvailabilityRule[]; afterRules: AvailabilityRule[]; overrides: Map<string, DateOverride>; doctor: ElasticDoctor }): string[] {
  const sessions = new Map<string, { before: Session[]; after: Session[] }>();
  const affected: string[] = [];
  for (const appointment of args.appointments) {
    let day = sessions.get(appointment.date);
    if (!day) {
      const override = args.overrides.get(appointment.date) ?? null;
      day = { before: slotsOn(appointment.date, args.rules, override, args.doctor).sessions, after: slotsOn(appointment.date, args.afterRules, override, args.doctor).sessions };
      sessions.set(appointment.date, day);
    }
    const start = hhmm(appointment.startTime);
    const end = hhmm(appointment.endTime);
    if (isCovered(day.before, start, end) && !isCovered(day.after, start, end)) affected.push(appointment.id);
  }
  return affected;
}

/**
 * The mirror of findAffected, for extending hours: appointments that are outside the doctor's working time with the current rules
 * and inside it with the proposed ones. An appointment that stays outside (a day off, a blocked time, or hours that still do not
 * reach it) is not included, and neither is one that was inside already.
 */
export function findRestored(args: { appointments: Placed[]; rules: AvailabilityRule[]; afterRules: AvailabilityRule[]; overrides: Map<string, DateOverride>; doctor: ElasticDoctor }): string[] {
  const sessions = new Map<string, { before: Session[]; after: Session[] }>();
  const restored: string[] = [];
  for (const appointment of args.appointments) {
    let day = sessions.get(appointment.date);
    if (!day) {
      const override = args.overrides.get(appointment.date) ?? null;
      day = { before: slotsOn(appointment.date, args.rules, override, args.doctor).sessions, after: slotsOn(appointment.date, args.afterRules, override, args.doctor).sessions };
      sessions.set(appointment.date, day);
    }
    const start = hhmm(appointment.startTime);
    const end = hhmm(appointment.endTime);
    if (!isCovered(day.before, start, end) && isCovered(day.after, start, end)) restored.push(appointment.id);
  }
  return restored;
}

/** A slot someone could still book, with the places left in it. */
export interface OpenSlot {
  date: string;
  startTime: string;
  endTime: string;
  remaining: number;
}

/**
 * The slots still open on one date for these rules: not booked up, not already past, not full. `booked` are the active
 * appointments that day (with their seats) and `cutoff` is the current time when the date is today.
 */
export function openSlotsOn(date: string, rules: AvailabilityRule[], override: DateOverride | null, doctor: ElasticDoctor, booked: BookedWindow[], cutoff: string | null): OpenSlot[] {
  const sessions = resolveDay(override, rules, date, { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultCapacity });
  return buildSlots(sessions, doctor.consultationMinutes, booked, cutoff, doctor.slotIntervalMinutes)
    .slots.filter((slot) => slot.status === 'AVAILABLE')
    .map((slot) => ({ date, startTime: slot.startTime, endTime: slot.endTime, remaining: slot.remaining ?? 1 }));
}
