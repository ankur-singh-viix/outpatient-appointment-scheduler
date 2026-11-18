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
 * Queue statuses that mean the visit is still open for the front desk / doctor today. A BOOKED token must stay CONFIRMED so
 * Late Arrival can run after the slot and grace end — even when later tokens have already checked in. Never auto-complete these.
 */
export const QUEUE_STATUSES_BLOCKING_AUTO_COMPLETE = ['BOOKED', 'WAITING', 'SERVING', 'SKIPPED'] as const;

/**
 * Marks CONFIRMED appointments whose end time has passed as COMPLETED, in the clinic's time zone. Nothing else is touched:
 * CANCELLED and NO_SHOW are final, an unpaid PENDING hold is released by its own job, and payments, refunds and the appointment's
 * history are not read or written. Repeating it changes nothing (a COMPLETED appointment is no longer CONFIRMED).
 *
 * Never auto-completes (or auto no-shows) a visit that still has a live queue place today (BOOKED / WAITING / SERVING / SKIPPED).
 * The receptionist marks no-show; the doctor (or desk) completes the consultation. Entries from earlier days no longer hold anyone back.
 *
 * Selection runs once in a MATERIALIZED CTE with FOR UPDATE SKIP LOCKED. A plain `UPDATE … WHERE id IN (SELECT … FOR UPDATE
 * LIMIT)` can re-execute the subquery per outer row in Postgres and incorrectly complete rows the NOT EXISTS guard should protect
 * (e.g. Ankur still BOOKED while Rahul has already checked in).
 */
export async function completeFinishedAppointments(dataSource: DataSource, now: Date, timeZone: string): Promise<number> {
  const clock = clinicNow(timeZone, now);
  let total = 0;
  // Before migration 015 there is no queue table, and the original statement runs unchanged.
  let respectQueue = true;
  const live = QUEUE_STATUSES_BLOCKING_AUTO_COMPLETE.map((status) => `'${status}'`).join(', ');
  for (;;) {
    let result: unknown;
    try {
      result = respectQueue
        ? await dataSource.query(
            `WITH due AS MATERIALIZED (
               SELECT a.id
                 FROM appointments a
                WHERE a.status = 'CONFIRMED'
                  AND (a.appointment_date < $1::date OR (a.appointment_date = $1::date AND a.end_time <= $2::time))
                  AND NOT EXISTS (
                        SELECT 1 FROM queue_entries q
                         WHERE q.appointment_id = a.id
                           AND q.status IN (${live})
                           AND q.queue_date >= $1::date
                      )
                ORDER BY a.appointment_date, a.id
                LIMIT $3
                  FOR UPDATE OF a SKIP LOCKED
             )
             UPDATE appointments AS target
                SET status = 'COMPLETED', updated_at = now()
               FROM due
              WHERE target.id = due.id AND target.status = 'CONFIRMED'
           RETURNING target.id`,
            [clock.date, clock.time, COMPLETE_BATCH],
          )
        : await dataSource.query(
            `WITH due AS MATERIALIZED (
               SELECT a.id
                 FROM appointments a
                WHERE a.status = 'CONFIRMED'
                  AND (a.appointment_date < $1::date OR (a.appointment_date = $1::date AND a.end_time <= $2::time))
                ORDER BY a.appointment_date, a.id
                LIMIT $3
                  FOR UPDATE OF a SKIP LOCKED
             )
             UPDATE appointments AS target
                SET status = 'COMPLETED', updated_at = now()
               FROM due
              WHERE target.id = due.id AND target.status = 'CONFIRMED'
           RETURNING target.id`,
            [clock.date, clock.time, COMPLETE_BATCH],
          );
    } catch (error) {
      const code = (error as { code?: unknown; driverError?: { code?: unknown } }).code ?? (error as { driverError?: { code?: unknown } }).driverError?.code;
      if (respectQueue && code === '42P01') {
        respectQueue = false;
        continue;
      }
      throw error;
    }
    // The driver returns [rows, count] for an UPDATE ... RETURNING.
    const done = Array.isArray(result) && Array.isArray(result[0]) ? result[0].length : Array.isArray(result) ? result.length : 0;
    total += done;
    if (done < COMPLETE_BATCH) return total;
  }
}
