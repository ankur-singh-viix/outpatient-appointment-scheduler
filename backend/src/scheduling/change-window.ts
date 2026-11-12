// The "minimum notice" rule for changing a doctor's schedule: a change that would affect an appointment is refused once that
// appointment is closer than N hours (default 2), or already under way. Pure date arithmetic in the clinic's own time (the caller
// passes the clinic-local date and time), so it is the same in preview and in the final application, and it is unit-testable.

import { addDays } from './calendar.js';
import { fromMinutes, hhmm, toMinutes } from './slots.js';

export interface ClinicClock {
  /** Clinic-local YYYY-MM-DD. */
  date: string;
  /** Clinic-local HH:MM. */
  time: string;
}

export interface BlockedAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  patientName: string | null;
}

/** The clinic-local moment `hours` after `now` (the end of the protected window). */
export function windowLimit(now: ClinicClock, hours: number): ClinicClock {
  const total = toMinutes(now.time) + Math.round(hours * 60);
  return { date: addDays(now.date, Math.floor(total / 1440)), time: fromMinutes(total % 1440) };
}

/**
 * Whether an appointment is inside the protected window: it has not ended yet, and it starts no later than `hours` from now
 * (an appointment already under way starts before now, so it is inside). With 0 hours the rule is off.
 */
export function insideWindow(appointment: { date: string; startTime: string; endTime: string }, now: ClinicClock, hours: number): boolean {
  if (hours <= 0) return false;
  const limit = windowLimit(now, hours);
  const start = `${appointment.date} ${hhmm(appointment.startTime)}`;
  const end = `${appointment.date} ${hhmm(appointment.endTime)}`;
  return end > `${now.date} ${now.time}` && start <= `${limit.date} ${limit.time}`;
}

const clock12 = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};
const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hoursText = (hours: number) => `${hours} hour${hours === 1 ? '' : 's'}`;

export interface WindowBlock {
  hours: number;
  /** Every appointment inside the window that the change would affect, earliest first. */
  blocked: BlockedAppointment[];
  earliest: BlockedAppointment;
  /** When the change can be made again: once the last blocking appointment has finished. */
  allowedFrom: ClinicClock;
  message: string;
}

/** Explains, for the doctor, why a change is refused and when it can be made. Undefined when nothing is blocked. */
export function describeBlock(blocked: BlockedAppointment[], hours: number, now: ClinicClock): WindowBlock | undefined {
  if (blocked.length === 0) return undefined;
  const sorted = [...blocked].sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
  const earliest = sorted[0];
  const last = [...sorted].sort((a, b) => `${b.date} ${b.endTime}`.localeCompare(`${a.date} ${a.endTime}`))[0];
  const allowedFrom = { date: last.date, time: hhmm(last.endTime) };
  const started = `${earliest.date} ${hhmm(earliest.startTime)}` <= `${now.date} ${now.time}`;
  const who = earliest.patientName ? `${earliest.patientName}'s appointment` : 'an appointment';
  const where = `${day(earliest.date)} at ${clock12(hhmm(earliest.startTime))}`;
  const count = blocked.length === 1 ? 'an appointment' : `${blocked.length} appointments`;
  const message =
    `This change would affect ${count} that ${blocked.length === 1 ? 'is' : 'are'} less than ${hoursText(hours)} away or already under way. ` +
    `The earliest is ${who}, ${started ? 'which started' : 'which starts'} ${where}. ` +
    `Schedule changes that affect an appointment are not allowed within ${hoursText(hours)} of it, so the patient is not caught out. ` +
    `You can make this change after ${blocked.length === 1 ? 'that appointment finishes' : 'those appointments finish'} (${day(allowedFrom.date)} at ${clock12(allowedFrom.time)}), ` +
    `or choose a change that does not affect ${blocked.length === 1 ? 'it' : 'them'}.`;
  return { hours, blocked: sorted, earliest, allowedFrom, message };
}

/** "Mon, 16 Nov at 9:00 AM": a clinic-local date and start time, for messages to the doctor. */
export function whenText(date: string, time: string): string {
  return `${day(date)} at ${clock12(hhmm(time))}`;
}
