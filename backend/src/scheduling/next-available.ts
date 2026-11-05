import { addDays, dayOfWeek } from './calendar.js';
import { resolveDay, type AvailabilityRule } from './availability-rules.js';
import { buildSlots, resolveSessions, type BookedWindow, type DateOverride, type WeeklyHours } from './slots.js';

export interface NextSlot {
  date: string;
  startTime: string;
  endTime: string;
}

export interface NextAvailableInput {
  consultationMinutes: number;
  /** A new slot starts this often. Defaults to the appointment length. */
  slotIntervalMinutes?: number;
  defaultCapacity: number;
  /** The doctor's weekly sessions, for any day of the week (the original form). Ignored when `rules` is given. */
  weekly: (WeeklyHours & { dayOfWeek: number })[];
  /** The doctor's availability rows, weekly and one-time, with slot length and capacity per slot. Takes the place of `weekly`. */
  rules?: AvailabilityRule[];
  /** Date exceptions, keyed by YYYY-MM-DD. */
  overrides: Map<string, DateOverride>;
  /** ACTIVE appointments, keyed by YYYY-MM-DD: their start times, or full start-end windows. */
  booked: Map<string, (string | BookedWindow)[]>;
  /** The current date and time in the clinic time zone. */
  today: { date: string; time: string };
  /** How many days to look through, counting today. */
  days: number;
}

/**
 * The first slot a patient could book, looking forward from now. It applies exactly the rules used to list slots and
 * to accept a booking (sessions, day-off exceptions, capacity, taken slots, slots already past today), so a card never
 * promises a time the server would refuse. Returns null when nothing is free in the window.
 */
export function findNextAvailable(input: NextAvailableInput): NextSlot | null {
  for (let offset = 0; offset < input.days; offset++) {
    const date = addDays(input.today.date, offset);
    const sessions = input.rules
      ? resolveDay(input.overrides.get(date) ?? null, input.rules, date, {
          consultationMinutes: input.consultationMinutes,
          defaultCapacity: input.defaultCapacity,
        })
      : resolveSessions(
          input.overrides.get(date) ?? null,
          input.weekly.filter((row) => row.dayOfWeek === dayOfWeek(date)),
          input.defaultCapacity,
        );
    if (sessions.length === 0) continue;

    const { slots } = buildSlots(
      sessions,
      input.consultationMinutes,
      input.booked.get(date) ?? [],
      offset === 0 ? input.today.time : null,
      input.slotIntervalMinutes ?? input.consultationMinutes,
    );
    const free = slots.find((slot) => slot.status === 'AVAILABLE');
    if (free) return { date, startTime: free.startTime, endTime: free.endTime };
  }
  return null;
}
