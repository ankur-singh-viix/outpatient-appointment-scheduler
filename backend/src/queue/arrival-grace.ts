/**
 * Front-desk arrival timing: how long after the appointment start a patient may still check in as a late arrival before the
 * receptionist may mark them no-show. Shared by the queue service and its tests; the frontend mirrors the same minutes.
 */

/** Minutes after the booked start before a manual no-show is allowed (within the agreed 10–15 minute window). */
export const ARRIVAL_GRACE_MINUTES = 15;

export type ArrivalPhase = 'on_time' | 'late' | 'no_show_eligible';

/** Minutes from HH:MM `from` to HH:MM `to` on the same calendar day (negative when `to` is earlier). */
export function minutesBetween(from: string, to: string): number {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return th * 60 + tm - (fh * 60 + fm);
}

/**
 * Where the clock sits relative to the appointment start and the grace window.
 * - on_time: before the start (or not today / future day)
 * - late: at or after the start, still inside the grace window
 * - no_show_eligible: grace has elapsed (receptionist may mark no-show; late check-in is still allowed)
 */
export function arrivalPhase(input: {
  appointmentDate: string;
  startTime: string;
  nowDate: string;
  nowTime: string;
  graceMinutes?: number;
}): ArrivalPhase {
  const grace = input.graceMinutes ?? ARRIVAL_GRACE_MINUTES;
  if (input.appointmentDate > input.nowDate) return 'on_time';
  if (input.appointmentDate < input.nowDate) return 'no_show_eligible';
  const elapsed = minutesBetween(input.startTime, input.nowTime);
  if (elapsed < 0) return 'on_time';
  if (elapsed < grace) return 'late';
  return 'no_show_eligible';
}

/** True when a check-in timestamp falls at or after the appointment's start in the clinic zone (a late arrival). */
export function isLateArrival(input: { appointmentDate: string; startTime: string; checkedInAt: Date; nowDate: string; nowTime: string }): boolean {
  // Compare on the appointment day using the clinic clock at check-in: if check-in is after start on that day, it is late.
  if (input.nowDate !== input.appointmentDate) return input.nowDate > input.appointmentDate;
  return minutesBetween(input.startTime, input.nowTime) >= 0;
}
