import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { AppointmentStatus } from '../database/entities/appointment.entity.js';
import { clinicNow } from '../scheduling/calendar.js';

/**
 * Which status an appointment may move to from each status. This is the whole lifecycle in one place; every writer that changes
 * a status checks it first.
 *
 *   PENDING   (an unpaid hold)     -> CONFIRMED (paid) or CANCELLED (released, or cancelled)
 *   CONFIRMED                      -> CANCELLED (patient, doctor, clinic; or moved by a reschedule), COMPLETED (its time has passed)
 *                                     or NO_SHOW
 *   CANCELLED, COMPLETED, NO_SHOW  -> nothing: they are final
 *
 * "Needs a new time", "rescheduled" and "restored" are not statuses: they are worked out from the appointment's hours and its
 * tracking records (schedule_change_appointments), so the appointment itself never changes because a doctor changed their hours.
 */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED', 'COMPLETED', 'NO_SHOW'],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}

/** Throws a 409 for a move the lifecycle does not allow, so a final appointment can never be reopened or overwritten. */
export function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`This appointment is ${from.replace('_', ' ').toLowerCase()} and cannot become ${to.replace('_', ' ').toLowerCase()}.`);
  }
}

/** How many appointments one statement completes; a bigger backlog is worked through in several statements. */
const COMPLETE_BATCH = 500;

/**
 * Marks CONFIRMED appointments whose end time has passed as COMPLETED, in the clinic's time zone. Nothing else is touched:
 * CANCELLED and NO_SHOW are final, an unpaid PENDING hold is released by its own job, and payments, refunds and the appointment's
 * history are not read or written. Repeating it changes nothing (a COMPLETED appointment is no longer CONFIRMED). Rows are taken
 * with SKIP LOCKED, so one being cancelled at this moment is left for the next pass instead of making this wait.
 * Returns how many were completed.
 */
export async function completeFinishedAppointments(dataSource: DataSource, now: Date, timeZone: string): Promise<number> {
  const clock = clinicNow(timeZone, now);
  let total = 0;
  for (;;) {
    const result: unknown = await dataSource.query(
      `UPDATE appointments SET status = 'COMPLETED', updated_at = now()
        WHERE id IN (SELECT id FROM appointments
                      WHERE status = 'CONFIRMED' AND (appointment_date < $1::date OR (appointment_date = $1::date AND end_time <= $2::time))
                      ORDER BY appointment_date, id LIMIT $3
                        FOR UPDATE SKIP LOCKED)
          AND status = 'CONFIRMED'
        RETURNING id`,
      [clock.date, clock.time, COMPLETE_BATCH],
    );
    // The driver returns [rows, count] for an UPDATE ... RETURNING.
    const done = Array.isArray(result) && Array.isArray(result[0]) ? result[0].length : Array.isArray(result) ? result.length : 0;
    total += done;
    if (done < COMPLETE_BATCH) return total;
  }
}
