import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Between, DataSource, type EntityManager } from 'typeorm';
import { loadConfig } from '../config.js';
import { Availability, Doctor, ScheduleOverride, slotIntervalOf } from '../database/entities/index.js';
import { MAX_NEW_TIME_REMINDERS } from '../notifications/templates.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { addDays, clinicNow } from './calendar.js';
import { toRule } from './day-schedule.js';
import { bookedLoader, openTimes } from './open-times.js';
import { appointmentsOutsideHours, toOverride } from './outside-hours.js';
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
    await reconcileAllDoctors(this.dataSource, clinicNow(this.config.clinicTimezone), (manager, ids) => this.notifications.appointmentsRestored(manager, ids));
    let asked = 0;
    const doctors = new Set<string>();
    for (let pass = 0; pass < maxPasses; pass++) {
      const { claimed, queued } = await this.runBatch(NOTIFY_BATCH, doctors);
      asked += queued;
      if (claimed < NOTIFY_BATCH) break;
    }
    // Right after the first messages: note which patients have no other time to choose, so they can be told when one opens up.
    for (const id of doctors) await this.recover(id).catch((error: Error) => this.logger.error(`Could not check availability for patients of doctor ${id}: ${error.message}`));
    if (asked > 0) this.notifications.kick();
    return asked;
  }

  async runBatch(limit = NOTIFY_BATCH, touchedDoctors?: Set<string>): Promise<{ claimed: number; queued: number }> {
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
      for (const id of byDoctor.keys()) touchedDoctors?.add(id);
      return { claimed: rows.length, queued };
    });
  }

  /**
   * Reminders for patients who were asked to choose a new time and have not: at most MAX_NEW_TIME_REMINDERS, each at least the cooldown
   * after the last contact (the first message, or the previous reminder). Each is a notification in the outbox, so every attempt is
   * on record. It stops by itself the moment the appointment is moved, cancelled, finished, or inside the hours again, and a
   * reminder already queued is checked again just before it is sent. Nothing is ever cancelled for not answering. Safe on two servers
   * at once (rows are taken with SKIP LOCKED, and each reminder has its own dedupe key). Returns how many were queued.
   */
  async remind(): Promise<number> {
    const clock = clinicNow(this.config.clinicTimezone);
    await this.closeEnded(this.dataSource.manager);
    await reconcileAllDoctors(this.dataSource, clock, (manager, ids) => this.notifications.appointmentsRestored(manager, ids));
    const queued = await this.dataSource.transaction(async (manager) => {
      const cutoff = new Date(Date.now() - this.config.scheduleReminderCooldownHours * 3_600_000);
      const claimed: (PendingRow & { created_at: Date })[] = await manager.query(
        `SELECT s.change_id, s.appointment_id, a.doctor_id, a.appointment_date::text AS appointment_date, a.start_time::text AS start_time, a.end_time::text AS end_time,
                NULL AS proposed_date, NULL AS proposed_start_time, NULL AS proposed_end_time, s.created_at
           FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id
          WHERE s.resolved_at IS NULL AND s.notified_at IS NOT NULL AND s.notified_at <= $1
            AND a.status IN ('PENDING', 'CONFIRMED') AND (a.appointment_date > $2::date OR (a.appointment_date = $2::date AND a.start_time > $3::time))
          ORDER BY s.notified_at LIMIT $4
            FOR UPDATE OF s SKIP LOCKED`,
        [cutoff, clock.date, clock.time, NOTIFY_BATCH],
      );
      if (claimed.length === 0) return 0;
      // One row per appointment (a patient stranded by two changes is reminded once, about the latest).
      const latest = new Map<string, (typeof claimed)[number]>();
      for (const row of claimed) if (!latest.has(row.appointment_id) || row.created_at > latest.get(row.appointment_id)!.created_at) latest.set(row.appointment_id, row);
      const rows = [...latest.values()];
      const outside = await this.stillOutside(manager, rows);
      const history: { appointment_id: string; kind: string; created_at: Date }[] = await manager.query(
        `SELECT appointment_id, kind, created_at FROM notifications
          WHERE appointment_id = ANY($1::uuid[]) AND kind IN ('needs-new-time', 'needs-new-time-reminder', 'new-times-available') AND status IN ('PENDING', 'SENT')`,
        [rows.map((row) => row.appointment_id)],
      );
      let count = 0;
      for (const row of rows) {
        if (!outside.has(row.appointment_id)) continue;
        const mine = history.filter((entry) => entry.appointment_id === row.appointment_id);
        // Reminders since the latest first message (a later, separate change starts the count again).
        const firstAt = mine.filter((entry) => entry.kind === 'needs-new-time').reduce((at, entry) => (entry.created_at > at ? entry.created_at : at), new Date(0));
        const reminders = mine.filter((entry) => entry.kind === 'needs-new-time-reminder' && entry.created_at >= firstAt).length;
        const lastContact = mine.reduce((latestAt, entry) => (entry.created_at > latestAt ? entry.created_at : latestAt), new Date(0));
        if (reminders >= MAX_NEW_TIME_REMINDERS || lastContact > cutoff) continue;
        try {
          await manager.transaction((inner) =>
            this.notifications.queueScheduleReminder(inner, row.appointment_id, {
              link: rescheduleLink(this.config.frontendUrl, row.doctor_id, row.appointment_id),
              key: `${row.change_id}:${reminders + 1}`,
              number: reminders + 1,
            }),
          );
          count++;
        } catch (error) {
          this.logger.error(`Could not queue reminder ${reminders + 1} for appointment ${row.appointment_id}: ${(error as Error).message}`);
        }
      }
      return count;
    });
    if (queued > 0) this.notifications.kick();
    return queued;
  }

  /**
   * Looks after patients who are still waiting for a new time (optionally one doctor's). For each, it asks the booking engine whether
   * any other time is open right now:
   *  - none: it is recorded (a CANCELLED "no-alternatives" notification, kept as an audit record and never sent);
   *  - some, and none was open before: the patient is emailed once that new times are open (one per gap, with a cooldown), so a
   *    patient who always had somewhere to go is never nagged.
   * Nothing is reserved for anyone: the patient confirms through the normal reschedule, first come first served.
   */
  async recover(doctorId?: string): Promise<{ marked: number; notified: number }> {
    const clock = clinicNow(this.config.clinicTimezone);
    await this.closeEnded(this.dataSource.manager);
    await reconcileAllDoctors(this.dataSource, clock, (manager, ids) => this.notifications.appointmentsRestored(manager, ids));
    const result = await this.dataSource.transaction(async (manager) => {
      const claimed: PendingRow[] = await manager.query(
        `SELECT s.change_id, s.appointment_id, a.doctor_id, a.appointment_date::text AS appointment_date, a.start_time::text AS start_time, a.end_time::text AS end_time,
                NULL AS proposed_date, NULL AS proposed_start_time, NULL AS proposed_end_time
           FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id
          WHERE s.resolved_at IS NULL AND s.notified_at IS NOT NULL
            AND a.status IN ('PENDING', 'CONFIRMED') AND (a.appointment_date > $1::date OR (a.appointment_date = $1::date AND a.start_time > $2::time))
            ${doctorId ? 'AND a.doctor_id = $4::uuid' : ''}
          ORDER BY s.notified_at LIMIT $3
            FOR UPDATE OF s SKIP LOCKED`,
        doctorId ? [clock.date, clock.time, NOTIFY_BATCH, doctorId] : [clock.date, clock.time, NOTIFY_BATCH],
      );
      const unique = [...new Map(claimed.map((row) => [row.appointment_id, row])).values()];
      if (unique.length === 0) return { marked: 0, notified: 0 };
      const outside = await this.stillOutside(manager, unique);
      const waiting = unique.filter((row) => outside.has(row.appointment_id));
      if (waiting.length === 0) return { marked: 0, notified: 0 };

      // Is anything open for each of them right now? One doctor at a time, so the days are worked out once and shared.
      const open = new Map<string, boolean>();
      for (const id of new Set(waiting.map((row) => row.doctor_id))) {
        const forDoctor = waiting.filter((row) => row.doctor_id === id);
        for (const [appointmentId, has] of await this.hasAlternatives(manager, id, forDoctor, clock)) open.set(appointmentId, has);
      }

      const state: { id: string; appointment_id: string; kind: string; created_at: Date }[] = await manager.query(
        `SELECT id, appointment_id, kind, created_at FROM notifications
          WHERE appointment_id = ANY($1::uuid[]) AND (kind = 'no-alternatives' OR (kind = 'new-times-available' AND status IN ('PENDING', 'SENT')))`,
        [waiting.map((row) => row.appointment_id)],
      );
      const cutoff = new Date(Date.now() - this.config.scheduleReminderCooldownHours * 3_600_000);
      const toMark: string[] = [];
      let notified = 0;
      for (const row of waiting) {
        const mine = state.filter((entry) => entry.appointment_id === row.appointment_id);
        const marker = mine.filter((entry) => entry.kind === 'no-alternatives').sort((x, y) => y.created_at.getTime() - x.created_at.getTime())[0];
        const lastTold = mine.filter((entry) => entry.kind === 'new-times-available').sort((x, y) => y.created_at.getTime() - x.created_at.getTime())[0];
        const inGap = marker !== undefined && (!lastTold || lastTold.created_at <= marker.created_at);
        if (!open.get(row.appointment_id)) {
          if (!inGap) toMark.push(row.appointment_id);
        } else if (inGap && (!lastTold || lastTold.created_at <= cutoff)) {
          try {
            await manager.transaction((inner) =>
              this.notifications.queueNewTimesAvailable(inner, row.appointment_id, { link: rescheduleLink(this.config.frontendUrl, row.doctor_id, row.appointment_id), key: marker.id }),
            );
            notified++;
          } catch (error) {
            this.logger.error(`Could not queue the new-times notice for appointment ${row.appointment_id}: ${(error as Error).message}`);
          }
        }
      }
      if (toMark.length > 0) await this.markNoAlternatives(manager, toMark);
      return { marked: toMark.length, notified };
    });
    if (result.notified > 0) this.notifications.kick();
    return result;
  }

  /** The appointments, of these, that are still outside their doctor's hours as they stand now (the hours may have been widened since). */
  private async stillOutside(manager: EntityManager, rows: PendingRow[]): Promise<Set<string>> {
    const outside = new Set<string>();
    const byDoctor = new Map<string, PendingRow[]>();
    for (const row of rows) byDoctor.set(row.doctor_id, [...(byDoctor.get(row.doctor_id) ?? []), row]);
    for (const [id, group] of byDoctor) {
      const found = await appointmentsOutsideHours(manager, id, group.map((row) => ({ id: row.appointment_id, date: row.appointment_date, startTime: row.start_time, endTime: row.end_time })));
      for (const appointmentId of found) outside.add(appointmentId);
    }
    return outside;
  }

  /** Whether at least one other time is open for each appointment, by the same rules booking uses. One doctor's rules and days are loaded once. */
  private async hasAlternatives(manager: EntityManager, doctorId: string, rows: PendingRow[], clock: { date: string; time: string }): Promise<Map<string, boolean>> {
    const doctor = await manager.findOneByOrFail(Doctor, { id: doctorId });
    const lastDate = addDays(clock.date, this.config.bookingWindowDays);
    const rules = (await manager.findBy(Availability, { doctorId })).map(toRule);
    const overrides = new Map((await manager.find(ScheduleOverride, { where: { doctorId, overrideDate: Between(clock.date, lastDate) } })).map((row) => [row.overrideDate, toOverride(row)]));
    const found = await openTimes({
      targets: rows.map((row) => ({ id: row.appointment_id, date: row.appointment_date, startTime: row.start_time, from: clock.date })),
      rules,
      overrides,
      elastic: { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity, slotIntervalMinutes: slotIntervalOf(doctor) },
      clock,
      lastDate,
      bookedOn: bookedLoader(manager, doctorId, lastDate),
      limit: 1,
    });
    return new Map(rows.map((row) => [row.appointment_id, (found.get(row.appointment_id) ?? []).length > 0]));
  }

  /** Records, for each appointment, that no other time was open now. A record only (status CANCELLED): it is never sent and patients never see it. */
  private async markNoAlternatives(manager: EntityManager, appointmentIds: string[]): Promise<void> {
    await manager.query(
      `INSERT INTO notifications (appointment_id, channel, category, recipient_user_id, recipient_role, kind, to_address, subject, body, status, last_error, dedupe_key)
       SELECT a.id, 'email', 'transactional', u.id, 'PATIENT', 'no-alternatives', u.email, 'No other time was open',
              'Recorded for the schedule-change audit trail: no other time was open for this appointment at this moment. Nothing was sent.',
              'CANCELLED', 'Not sent: this is a record, not a message.', 'no-alternatives:' || a.id || ':' || $2
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id
        WHERE a.id = ANY($1::uuid[])
       ON CONFLICT DO NOTHING`,
      [appointmentIds, String(Date.now())],
    );
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
