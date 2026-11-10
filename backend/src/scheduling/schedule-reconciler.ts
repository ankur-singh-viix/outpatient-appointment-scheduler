import type { DataSource, EntityManager } from 'typeorm';
import { appointmentsOutsideHours } from './outside-hours.js';

/** Appointments checked per step. Memory stays at one chunk however many appointments are waiting. */
const CHUNK = 500;
/** Most chunks one call works through. Whatever is left is picked up by the background sweep. */
export const MAX_CHUNKS_IN_REQUEST = 4;
const MAX_CHUNKS_IN_SWEEP = 10;

export const WITHDRAWN_NOTICE = "Not sent: the appointment is within the doctor's hours again.";

/** Called inside the release transaction with the appointments it just released (to queue the patients' "valid again" messages). */
export type ReleasedHook = (manager: EntityManager, appointmentIds: string[]) => Promise<unknown>;

export interface ReconcileResult {
  /** Appointments whose open tracking rows were closed as COVERED. */
  restored: number;
  /** Queued "choose a new time" messages withdrawn before they were sent. */
  withdrawn: number;
  /** True when more waiting appointments remain than one call handles. The background sweep finishes them. */
  more: boolean;
}

/** The rows an UPDATE ... RETURNING gave back. The Postgres driver wraps them as [rows, count] for updates, unlike for selects. */
function returned<T>(result: unknown): T[] {
  return (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as T[];
}

interface Waiting {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
}

/**
 * Brings the bookkeeping for "appointment is outside the doctor's hours" back in line with the hours as they are now. Run after
 * anything that can widen the hours (extending a session, a new one-time session, lifting a date exception).
 *
 * It looks only at upcoming, still-active appointments of one doctor that something is waiting on: an open tracking row
 * (schedule_change_appointments) or a "choose a new time" message that has not been sent yet. For each one that is inside the
 * hours again it (1) closes every open tracking row as COVERED and (2) cancels the queued message. Nothing else is touched:
 * appointments, payments and refunds are never read or written, rows that were already resolved (RESCHEDULED, CANCELLED, CLOSED,
 * COVERED) are never changed, and appointments that are still outside the hours keep waiting.
 *
 * It must run in the transaction that changed the hours (with the doctor row locked), so the hours it checks are the new ones and
 * nobody can see the new hours with the old bookkeeping. It sends nothing. Every step is safe to repeat.
 */
export async function reconcileCoverage(
  manager: EntityManager,
  doctorId: string,
  clock: { date: string; time: string },
  maxChunks = MAX_CHUNKS_IN_REQUEST,
  onReleased?: ReleasedHook,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { restored: 0, withdrawn: 0, more: false };
  let after = '00000000-0000-0000-0000-000000000000';
  for (let chunk = 0; ; chunk++) {
    if (chunk === maxChunks) {
      result.more = true;
      return result;
    }
    // FOR SHARE: an appointment being cancelled or moved at this very moment finishes first (and is then no longer active, so it
    // is not picked up here), or waits until this transaction ends. Cancelling does not take the doctor lock, so it needs this.
    const waiting: Waiting[] = await manager.query(
      `SELECT a.id, a.appointment_date::text AS date, a.start_time::text AS start_time, a.end_time::text AS end_time
         FROM appointments a
        WHERE a.doctor_id = $1 AND a.id > $2
          AND a.status IN ('PENDING', 'CONFIRMED')
          AND NOT (a.status = 'PENDING' AND a.hold_expires_at IS NOT NULL AND a.hold_expires_at <= now())
          AND (a.appointment_date > $3::date OR (a.appointment_date = $3::date AND a.start_time > $4::time))
          AND (EXISTS (SELECT 1 FROM schedule_change_appointments s WHERE s.appointment_id = a.id AND s.resolved_at IS NULL)
               OR EXISTS (SELECT 1 FROM notifications n WHERE n.appointment_id = a.id AND n.kind IN ('needs-new-time', 'needs-new-time-reminder', 'new-times-available') AND n.status = 'PENDING'))
        ORDER BY a.id
        LIMIT ${CHUNK}
          FOR SHARE OF a`,
      [doctorId, after, clock.date, clock.time],
    );
    if (waiting.length === 0) return result;
    after = waiting[waiting.length - 1].id;

    const outside = await appointmentsOutsideHours(
      manager,
      doctorId,
      waiting.map((row) => ({ id: row.id, date: row.date, startTime: row.start_time, endTime: row.end_time })),
    );
    const covered = waiting.filter((row) => !outside.has(row.id)).map((row) => row.id);
    if (covered.length > 0) {
      // Waits for a notifier batch that holds some of these rows (it never waits on this transaction), then closes what is still open.
      const closed = returned<{ appointment_id: string }>(await manager.query(
        `UPDATE schedule_change_appointments SET resolved_at = now(), resolution = 'COVERED'
          WHERE appointment_id = ANY($1::uuid[]) AND resolved_at IS NULL
          RETURNING appointment_id`,
        [covered],
      ));
      const released = [...new Set(closed.map((row) => row.appointment_id))];
      result.restored += released.length;
      // Told in the same transaction (a database insert, never a send), only for appointments this call actually released.
      if (onReleased && released.length > 0) await onReleased(manager, released);
      // After the rows above, so a message the notifier queued while we waited is seen too. A message the dispatcher is sending at
      // this moment is skipped (it is locked and cannot be recalled), and must not hold this transaction up for the length of an email.
      const withdrawn = returned<{ id: string }>(await manager.query(
        `UPDATE notifications SET status = 'CANCELLED', last_error = $2, updated_at = now()
          WHERE id IN (SELECT id FROM notifications WHERE appointment_id = ANY($1::uuid[]) AND kind IN ('needs-new-time', 'needs-new-time-reminder', 'new-times-available') AND status = 'PENDING' FOR UPDATE SKIP LOCKED)
          RETURNING id`,
        [covered, WITHDRAWN_NOTICE],
      ));
      result.withdrawn += withdrawn.length;
    }
    if (waiting.length < CHUNK) return result;
  }
}

/**
 * Background safety net: reconciles every doctor that has something waiting. It catches anything a request could not finish
 * (a very large backlog, or a lock that was busy) and any change of hours made outside the application. Each doctor is handled in
 * its own short transaction.
 */
export async function reconcileAllDoctors(dataSource: DataSource, clock: { date: string; time: string }, onReleased?: ReleasedHook): Promise<ReconcileResult> {
  const total: ReconcileResult = { restored: 0, withdrawn: 0, more: false };
  const doctors: { doctor_id: string }[] = await dataSource.query(
    // Starts from the two small partial indexes (open tracking rows, queued messages), never from the whole appointments table.
    `SELECT DISTINCT a.doctor_id
       FROM (SELECT appointment_id FROM schedule_change_appointments WHERE resolved_at IS NULL
             UNION
             SELECT appointment_id FROM notifications WHERE status = 'PENDING' AND kind IN ('needs-new-time', 'needs-new-time-reminder', 'new-times-available') AND appointment_id IS NOT NULL) w
       JOIN appointments a ON a.id = w.appointment_id AND a.status IN ('PENDING', 'CONFIRMED')`,
  );
  for (const { doctor_id } of doctors) {
    const done = await dataSource.transaction((manager) => reconcileCoverage(manager, doctor_id, clock, MAX_CHUNKS_IN_SWEEP, onReleased));
    total.restored += done.restored;
    total.withdrawn += done.withdrawn;
    total.more ||= done.more;
  }
  return total;
}
