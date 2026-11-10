import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { loadConfig } from '../config.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { clinicNow } from './calendar.js';
import { appointmentsOutsideHours } from './outside-hours.js';
import { reconcileAllDoctors } from './schedule-reconciler.js';
import { hhmm } from './slots.js';

/** How many patients one pass asks. A bigger change is simply worked through over several passes. */
export const NOTIFY_BATCH = 200;
/** A row whose notice could not be queued this many times is left for the doctor to see and ask again manually. */
export const MAX_ATTEMPTS = 5;
const REPEAT_WINDOW_MS = 24 * 3_600_000;

interface PendingRow {
  change_id: string;
  appointment_id: string;
  doctor_id: string;
  appointment_date: string;
  start_time: string;
  end_time: string;
  proposed_date: string | null;
  proposed_start_time: string | null;
  proposed_end_time: string | null;
}

export function rescheduleLink(frontendUrl: string, doctorId: string, appointmentId: string, date?: string | null): string {
  return `${frontendUrl}/doctors/${doctorId}?reschedule=${appointmentId}${date ? `&date=${date}` : ''}`;
}

/**
 * Works through the appointments a reduction of the doctor's hours left outside them (schedule_change_appointments), in the
 * background and in batches, so the doctor's request never waits on thousands of notices and a failure in one never loses the rest.
 *
 * Each pass: (1) closes rows whose appointment has since ended (moved, cancelled, completed); (2) claims a batch of unsent rows
 * with FOR UPDATE SKIP LOCKED (two servers never take the same row); (3) closes rows whose appointment is inside the hours again;
 * (4) for the rest, queues the patient's message in the outbox unless they were already asked in the last 24 hours. Queuing is a
 * database insert; sending happens later in the outbox dispatcher, so no transaction is ever open during an email or text.
 * Every step is safe to repeat: the message has a dedupe key per appointment and change.
 */
@Injectable()
export class ScheduleChangeNotifier {
  private readonly logger = new Logger('ScheduleChanges');
  private readonly config = loadConfig();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /** Runs passes until the queue is empty or `maxPasses` is reached. Returns how many patients were asked. */
  async drain(maxPasses = 20): Promise<number> {
    // First let go of everyone the hours have already caught up with (including ones already told), so none of them is asked.
    await reconcileAllDoctors(this.dataSource, clinicNow(this.config.clinicTimezone));
    let asked = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      const { claimed, queued } = await this.runBatch();
      asked += queued;
      if (claimed < NOTIFY_BATCH) break;
    }
    if (asked > 0) this.notifications.kick();
    return asked;
  }

  async runBatch(limit = NOTIFY_BATCH): Promise<{ claimed: number; queued: number }> {
    await this.closeEnded(this.dataSource.manager);
    return this.dataSource.transaction(async (manager) => {
      const rows: PendingRow[] = await manager.query(
        `SELECT s.change_id, s.appointment_id, a.doctor_id, a.appointment_date::text AS appointment_date,
                a.start_time::text AS start_time, a.end_time::text AS end_time,
                s.proposed_date::text AS proposed_date, s.proposed_start_time::text AS proposed_start_time, s.proposed_end_time::text AS proposed_end_time
           FROM schedule_change_appointments s
           JOIN appointments a ON a.id = s.appointment_id
          WHERE s.notified_at IS NULL AND s.resolved_at IS NULL AND s.attempts < $2 AND a.status IN ('PENDING', 'CONFIRMED')
          ORDER BY s.attempts, s.created_at, s.appointment_id
          LIMIT $1
            FOR UPDATE OF s SKIP LOCKED`,
        [limit, MAX_ATTEMPTS],
      );
      if (rows.length === 0) return { claimed: 0, queued: 0 };

      // Still outside the hours? (The hours may have been widened again since.) One rules load per doctor, not per appointment.
      const byDoctor = new Map<string, PendingRow[]>();
      for (const row of rows) byDoctor.set(row.doctor_id, [...(byDoctor.get(row.doctor_id) ?? []), row]);
      const outside = new Set<string>();
      for (const [doctorId, group] of byDoctor) {
        const found = await appointmentsOutsideHours(
          manager,
          doctorId,
          group.map((row) => ({ id: row.appointment_id, date: row.appointment_date, startTime: row.start_time, endTime: row.end_time })),
        );
        for (const id of found) outside.add(id);
      }
      const covered = rows.filter((row) => !outside.has(row.appointment_id));
      if (covered.length > 0) await this.mark(manager, covered, `resolved_at = now(), resolution = 'COVERED'`);
      const todo = rows.filter((row) => outside.has(row.appointment_id));

      // Already asked within the last day (by an earlier change, or by the doctor asking again)? Then do not ask twice.
      const recent = new Set<string>(
        (
          // A message withdrawn before it was sent (CANCELLED) or one that could never be delivered (FAILED) did not ask the patient anything.
          await manager.query(`SELECT DISTINCT appointment_id FROM notifications WHERE appointment_id = ANY($1::uuid[]) AND kind = 'needs-new-time' AND status IN ('PENDING', 'SENT') AND created_at > $2`, [
            todo.map((row) => row.appointment_id),
            new Date(Date.now() - REPEAT_WINDOW_MS),
          ])
        ).map((row: { appointment_id: string }) => row.appointment_id),
      );

      const done: PendingRow[] = [];
      const failed: PendingRow[] = [];
      let queued = 0;
      for (const row of todo) {
        if (recent.has(row.appointment_id)) {
          done.push(row);
          continue;
        }
        try {
          // A savepoint per patient: one bad row rolls back only itself.
          await manager.transaction((inner) => this.queueOne(inner, row));
          done.push(row);
          queued++;
        } catch (error) {
          failed.push(row);
          this.logger.error(`Could not queue the new-time notice for appointment ${row.appointment_id}: ${(error as Error).message}`);
        }
      }
      if (done.length > 0) await this.mark(manager, done, 'notified_at = now()');
      if (failed.length > 0) await this.mark(manager, failed, 'attempts = attempts + 1');
      return { claimed: rows.length, queued };
    });
  }

  /** Sets columns on exactly these tracking rows, in one statement. `assignments` is fixed SQL written in this file, never user input. */
  private async mark(manager: EntityManager, rows: PendingRow[], assignments: string): Promise<void> {
    await manager.query(`UPDATE schedule_change_appointments SET ${assignments} WHERE (change_id, appointment_id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))`, [
      rows.map((row) => row.change_id),
      rows.map((row) => row.appointment_id),
    ]);
  }

  private async queueOne(manager: EntityManager, row: PendingRow): Promise<void> {
    const proposed =
      row.proposed_date && row.proposed_start_time && row.proposed_end_time
        ? { date: row.proposed_date, startTime: hhmm(row.proposed_start_time), endTime: hhmm(row.proposed_end_time) }
        : undefined;
    await this.notifications.queueNewTimeRequest(manager, row.appointment_id, {
      link: rescheduleLink(this.config.frontendUrl, row.doctor_id, row.appointment_id, proposed?.date),
      changeKey: row.change_id,
      proposed,
    });
  }

  /** Closes the open rows of appointments that are no longer active, with how they ended. Set-based, one statement. */
  async closeEnded(manager: EntityManager): Promise<void> {
    await manager.query(
      `UPDATE schedule_change_appointments s
          SET resolved_at = COALESCE(a.cancelled_at, now()),
              resolution = CASE
                WHEN a.status = 'CANCELLED' AND a.cancel_reason = 'Rescheduled by patient' THEN 'RESCHEDULED'
                WHEN a.status = 'CANCELLED' THEN 'CANCELLED'
                ELSE 'CLOSED' END
         FROM appointments a
        WHERE a.id = s.appointment_id AND s.resolved_at IS NULL AND a.status NOT IN ('PENDING', 'CONFIRMED')`,
    );
  }
}
