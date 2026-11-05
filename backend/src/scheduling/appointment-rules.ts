import { toMinutes } from './slots.js';

const ACTIVE = ['PENDING', 'CONFIRMED'];

/**
 * Whether a patient may still cancel or reschedule an appointment.
 * Returns the reason it is blocked, or null when the change is allowed:
 * - only active (pending or confirmed) appointments can change, never cancelled, completed or no-show ones;
 * - an appointment that has already started, or is in the past, cannot change.
 * `now` is the current date and time in the clinic time zone.
 */
export function changeBlockedReason(
  appointment: { status: string; date: string; startTime: string },
  now: { date: string; time: string },
): string | null {
  if (!ACTIVE.includes(appointment.status)) {
    return `This appointment is already ${appointment.status.replace('_', ' ').toLowerCase()} and cannot be changed.`;
  }
  const started =
    appointment.date < now.date ||
    (appointment.date === now.date && toMinutes(appointment.startTime) <= toMinutes(now.time));
  if (started) return 'This appointment has already started or passed, so it can no longer be changed.';
  return null;
}
