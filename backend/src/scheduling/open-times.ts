import type { EntityManager } from 'typeorm';
import { ACTIVE_STATUSES, Appointment } from '../database/entities/index.js';
import { addDays } from './calendar.js';
import type { AvailabilityRule } from './availability-rules.js';
import { openSlotsOn, type ElasticDoctor, type OpenSlot } from './elastic.js';
import { hhmm, type BookedWindow, type DateOverride } from './slots.js';

/** Days of booked windows read per query when a search walks forward. */
const BOOKED_CHUNK_DAYS = 7;

export type BookedOn = (date: string) => Promise<BookedWindow[]>;

/**
 * Reads the doctor's booked windows (narrow columns only) a few days at a time, only when a search reaches those days, and
 * remembers them. An unpaid hold whose time has run out no longer holds its slot. The search below stops as soon as it has enough,
 * so it reads the first week or two, not every appointment the doctor has.
 */
export function bookedLoader(manager: EntityManager, doctorId: string, lastDate: string): BookedOn {
  const cache = new Map<string, BookedWindow[]>();
  return async (date) => {
    if (!cache.has(date)) {
      const last = [addDays(date, BOOKED_CHUNK_DAYS - 1), lastDate].sort()[0];
      const rows = await manager
        .createQueryBuilder(Appointment, 'a')
        .select(['a.appointmentDate', 'a.startTime', 'a.endTime', 'a.slotNumber'])
        .where('a.doctorId = :doctorId', { doctorId })
        .andWhere('a.appointmentDate BETWEEN :from AND :to', { from: date, to: last })
        .andWhere('a.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .andWhere(`NOT (a.status = 'PENDING' AND a.holdExpiresAt IS NOT NULL AND a.holdExpiresAt <= :now)`, { now: new Date() })
        .getMany();
      for (let day = date; day <= last; day = addDays(day, 1)) cache.set(day, []);
      for (const row of rows) cache.get(row.appointmentDate)!.push({ startTime: hhmm(row.startTime), endTime: hhmm(row.endTime), slotNumber: row.slotNumber });
    }
    return cache.get(date) ?? [];
  };
}

export interface OpenTimeTarget {
  id: string;
  /** The target's own date. The search starts here (or today, if that has passed) unless `from` says otherwise. */
  date: string;
  /** Its own start time, never offered back as an alternative. */
  startTime: string;
  /** Where the search starts instead of the target's own date: a patient is searched from today, so earlier open dates are not missed. */
  from?: string;
  /** Resume after this time (a cursor): nothing at or before it is returned. */
  after?: { date: string; startTime: string };
}

/**
 * Up to `limit` open times for each target, nearest first: its own day, then the following days, until the end of the booking
 * window. A time is open when the rules offer it and it has a free place and has not started. Days are walked lazily and each
 * day is worked out once however many targets share it, so the cost is the days actually visited times the slots per day, and
 * it stops early. The database still has the last word when a patient confirms (a taken time is refused there).
 */
export async function openTimes(args: {
  targets: OpenTimeTarget[];
  rules: AvailabilityRule[];
  overrides: Map<string, DateOverride>;
  elastic: ElasticDoctor;
  clock: { date: string; time: string };
  lastDate: string;
  bookedOn: BookedOn;
  limit: number;
  /** A time that must not be offered whatever the rules say (for example one that overlaps the patient's own other appointment). */
  exclude?: (date: string, slot: OpenSlot) => boolean;
}): Promise<Map<string, OpenSlot[]>> {
  const { clock } = args;
  const open = new Map<string, OpenSlot[]>();
  const openOn = async (date: string) => {
    let slots = open.get(date);
    if (!slots) {
      slots = openSlotsOn(date, args.rules, args.overrides.get(date) ?? null, args.elastic, await args.bookedOn(date), date === clock.date ? clock.time : null);
      open.set(date, slots);
    }
    return slots;
  };
  const result = new Map<string, OpenSlot[]>();
  for (const target of args.targets) {
    const found: OpenSlot[] = [];
    let start = target.from ?? target.date;
    if (start < clock.date) start = clock.date;
    if (target.after && target.after.date > start) start = target.after.date;
    for (let date = start; date <= args.lastDate && found.length < args.limit; date = addDays(date, 1)) {
      for (const slot of await openOn(date)) {
        if (found.length >= args.limit) break;
        if (date === target.date && slot.startTime === hhmm(target.startTime)) continue;
        if (target.after && (date < target.after.date || (date === target.after.date && slot.startTime <= target.after.startTime))) continue;
        if (args.exclude?.(date, slot)) continue;
        found.push(slot);
      }
    }
    result.set(target.id, found);
  }
  return result;
}
