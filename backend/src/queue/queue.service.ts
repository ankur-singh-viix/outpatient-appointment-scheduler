import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { assertTransition } from '../appointments/appointment-lifecycle.js';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { Appointment, Doctor, DoctorReceptionistAssignment, Patient, QueueEntry, QueueEvent, type QueueStatus } from '../database/entities/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { clinicNow } from '../scheduling/calendar.js';
import { hhmm } from '../scheduling/slots.js';
import { ARRIVAL_GRACE_MINUTES, arrivalPhase } from './arrival-grace.js';
import { issueBookedQueueToken } from './issue-token.js';
import { assertQueueTransition, eventFor } from './queue-lifecycle.js';
import { buildDay, positionOf, type Day, type DayRow } from './queue-position.js';

/** True when a query failed because a table does not exist (the database has not been migrated to 015 yet). */
export function isMissingQueueTable(error: unknown): boolean {
  const e = (error as { code?: unknown; driverError?: { code?: unknown } } | null) ?? {};
  return e.code === '42P01' || e.driverError?.code === '42P01';
}

/** One entry of a doctor's day, with what the screens need. No phone number, no medical information. */
interface QueueRow extends DayRow {
  appointmentId: string;
  doctorId: string;
  doctorName: string;
  queueDate: string;
  startTime: string;
  endTime: string;
  patientName: string;
  /** Present for the front desk; null on patient-facing responses that never read this field. */
  patientPhone: string | null;
  checkedInAt: Date | null;
  calledAt: Date | null;
  completedAt: Date | null;
  checkedOutAt: Date | null;
  updatedAt: Date;
}

const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ statusCode: 409, error: 'Conflict', code, message, ...extra });

/**
 * The queue: doctor-wise tokens (issued at booking), check-in and checkout by the receptionist, calling and completing by the doctor.
 *
 *  - A token belongs to one doctor and one day. It is allocated when the appointment is confirmed (status BOOKED), under the doctor
 *    lock, and the database refuses a repeated token as well as a second entry for the same appointment and a second patient being
 *    served at once. Check-in reuses that token and only moves BOOKED -> WAITING.
 *  - The appointment keeps its own status. A cancelled appointment is recognised from that status (never copied here), so the
 *    existing cancel and reschedule code needs no knowledge of the queue. When the doctor completes a consultation the appointment
 *    becomes COMPLETED through the transition the appointment lifecycle already allows.
 *  - Positions are worked out from the real entries on every request, never from stored counts.
 *  - Every change is written to queue_events with who made it.
 */
@Injectable()
export class QueueService {
  private readonly config = loadConfig();

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Issues a BOOKED token for a just-confirmed appointment. Caller must hold the doctor lock. Exported for booking and payment
   * confirmation so they share one allocation path with check-in.
   */
  issueTokenInTransaction(
    manager: EntityManager,
    input: { appointmentId: string; doctorId: string; patientId: string; queueDate: string; actorUserId: string },
  ) {
    return issueBookedQueueToken(manager, input);
  }

  // ---- Receptionist ----

  /**
   * Checks a patient in for a CONFIRMED appointment on its day, reusing the booking-time token (never allocating a new one).
   * Allowed any time today while the entry is still BOOKED — including after the appointment start and after the arrival grace
   * (late arrival). Grace only gates the separate manual no-show action; this never auto-marks NO_SHOW or COMPLETED.
   * If a background job incorrectly marked the appointment COMPLETED while the queue row stayed BOOKED (never consulted), restores
   * CONFIRMED first so Late Arrival / No Show still work.
   */
  async checkIn(user: AuthUser, appointmentId: string) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      const today = this.today();
      const entryId = await this.dataSource.transaction(async (manager) => {
        const found = await manager.findOne(Appointment, { where: { id: appointmentId }, relations: { doctor: true } });
        if (!found || !doctorIds.includes(found.doctorId)) throw new NotFoundException('Appointment not found.');
        // Doctor first, then the appointment: the order booking uses, so the two can never wait on each other.
        await this.lockDoctor(manager, found.doctorId);
        const appointment = await manager.findOneOrFail(Appointment, { where: { id: appointmentId }, lock: { mode: 'pessimistic_write' } });
        if (appointment.status === 'PENDING') throw conflict('PAYMENT_PENDING', 'This booking is still waiting for payment, so the patient cannot be checked in yet.');

        const existing = await manager.findOne(QueueEntry, { where: { appointmentId }, lock: { mode: 'pessimistic_write' } });
        if (existing) await this.restoreMistakenCompletionIfNeverArrived(manager, appointment, existing, user);

        if (appointment.status === 'NO_SHOW') {
          throw conflict('NO_SHOW', 'This appointment was marked no show. Use Reopen & Late Check-in if the patient has now arrived.');
        }
        if (appointment.status !== 'CONFIRMED') throw conflict('NOT_ELIGIBLE', `This appointment is ${appointment.status.replace('_', ' ').toLowerCase()}, so the patient cannot be checked in.`);
        if (appointment.appointmentDate !== today) {
          throw conflict('NOT_TODAY', appointment.appointmentDate > today ? 'This appointment is not today, so the patient cannot be checked in yet.' : 'This appointment was on an earlier day, so the patient cannot be checked in.');
        }
        if (!existing) {
          throw conflict('TOKEN_MISSING', 'This appointment has no queue token yet. It must be issued when the booking is confirmed.');
        }
        if (existing.status !== 'BOOKED') {
          throw conflict('ALREADY_CHECKED_IN', `This patient is already checked in with token ${existing.tokenNumber}.`, { token: existing.tokenNumber });
        }

        await this.move(manager, existing, 'WAITING', user, { checkedInAt: new Date(), checkedInByUserId: user.id });
        // The patient is told their (existing) token and how many are ahead among those already waiting. Queued in this transaction.
        const position = positionOf(buildDay(await this.dayRows(manager, appointment.doctorId, today)), existing.id);
        await this.notifications.queueCheckedIn(manager, appointmentId, { entryId: existing.id, token: existing.tokenNumber, ahead: position?.ahead ?? 0 });
        return existing.id;
      });
      this.notifications.kick();
      return this.describe(entryId);
    });
  }

  /** Checks a patient out after their consultation was completed, and only then. */
  async checkOut(user: AuthUser, entryId: string) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      await this.dataSource.transaction(async (manager) => {
        const entry = await this.entryForAssignedDoctors(manager, entryId, doctorIds);
        await this.move(manager, entry, 'CHECKED_OUT', user, { checkedOutAt: new Date(), checkedOutByUserId: user.id });
      });
      return this.describe(entryId);
    });
  }

  /**
   * Manual no-show at the front desk: only after the arrival grace (ARRIVAL_GRACE_MINUTES) has elapsed, for a patient who never
   * checked in (BOOKED) or who was skipped and will not return. Sets the appointment to NO_SHOW (history kept, slot freed).
   * BOOKED entries stay BOOKED in storage (check-in columns must stay null); the board treats them as cancelled via the
   * appointment status. Skipped entries move to CANCELLED. No refund — unlike an explicit cancel.
   */
  async markNoShow(user: AuthUser, appointmentId: string) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      const clock = clinicNow(this.config.clinicTimezone);
      const entryId = await this.dataSource.transaction(async (manager) => {
        const found = await manager.findOne(Appointment, { where: { id: appointmentId }, relations: { doctor: true } });
        if (!found || !doctorIds.includes(found.doctorId)) throw new NotFoundException('Appointment not found.');
        await this.lockDoctor(manager, found.doctorId);
        const appointment = await manager.findOneOrFail(Appointment, { where: { id: appointmentId }, lock: { mode: 'pessimistic_write' } });
        const existing = await manager.findOne(QueueEntry, { where: { appointmentId }, lock: { mode: 'pessimistic_write' } });
        if (!existing) throw conflict('TOKEN_MISSING', 'This appointment has no queue token.');
        await this.restoreMistakenCompletionIfNeverArrived(manager, appointment, existing, user);

        if (appointment.status !== 'CONFIRMED') {
          throw conflict('NOT_ELIGIBLE', `This appointment is ${appointment.status.replace('_', ' ').toLowerCase()}, so it cannot be marked no-show.`);
        }
        if (appointment.appointmentDate !== clock.date) {
          throw conflict('NOT_TODAY', appointment.appointmentDate > clock.date ? 'Only today\'s appointments can be marked no-show.' : 'This appointment was on an earlier day.');
        }

        const phase = arrivalPhase({
          appointmentDate: appointment.appointmentDate,
          startTime: hhmm(appointment.startTime),
          nowDate: clock.date,
          nowTime: clock.time,
          graceMinutes: ARRIVAL_GRACE_MINUTES,
        });
        if (phase !== 'no_show_eligible') {
          throw conflict(
            'GRACE_NOT_ELAPSED',
            `Wait until ${ARRIVAL_GRACE_MINUTES} minutes after the appointment start before marking a no-show. The patient may still arrive late.`,
            { graceMinutes: ARRIVAL_GRACE_MINUTES },
          );
        }

        if (existing.status !== 'BOOKED' && existing.status !== 'SKIPPED') {
          throw conflict(
            'NOT_ELIGIBLE',
            existing.status === 'WAITING' || existing.status === 'SERVING'
              ? 'This patient is already in the active queue. Skip them if they are not available, or complete the consultation.'
              : `This patient is ${existing.status.replace('_', ' ').toLowerCase()} and cannot be marked no-show.`,
          );
        }

        assertTransition(appointment.status, 'NO_SHOW');
        appointment.status = 'NO_SHOW';
        appointment.cancelReason = 'Marked no show at front desk';
        appointment.cancelledAt = new Date();
        appointment.cancelledByUserId = user.id;
        await manager.save(appointment);

        // Never-checked-in rows cannot become CANCELLED under ck_queue_checked_in_consistency; the board reads NO_SHOW as cancelled.
        if (existing.status === 'SKIPPED') {
          await this.move(manager, existing, 'CANCELLED', user, {});
        } else {
          await this.record(manager, existing.id, existing.status, 'CANCELLED', user);
        }
        return existing.id;
      });
      return this.describe(entryId);
    });
  }

  /**
   * After a manual no-show, if the patient arrives later the same day: restore CONFIRMED, check them in late with the original
   * token (BOOKED or CANCELLED queue row → WAITING), and record the change. Refused for cancelled appointments, completed
   * consultations, and checked-out visits.
   */
  async reopenLateCheckIn(user: AuthUser, appointmentId: string) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      const today = this.today();
      const entryId = await this.dataSource.transaction(async (manager) => {
        const found = await manager.findOne(Appointment, { where: { id: appointmentId }, relations: { doctor: true } });
        if (!found || !doctorIds.includes(found.doctorId)) throw new NotFoundException('Appointment not found.');
        await this.lockDoctor(manager, found.doctorId);
        const appointment = await manager.findOneOrFail(Appointment, { where: { id: appointmentId }, lock: { mode: 'pessimistic_write' } });
        const existing = await manager.findOne(QueueEntry, { where: { appointmentId }, lock: { mode: 'pessimistic_write' } });
        if (!existing) throw conflict('TOKEN_MISSING', 'This appointment has no queue token.');

        if (appointment.status === 'CANCELLED') {
          throw conflict('NOT_ELIGIBLE', 'This appointment was cancelled and cannot be reopened for check-in.');
        }
        if (existing.status === 'COMPLETED' || existing.status === 'CHECKED_OUT' || appointment.status === 'COMPLETED') {
          throw conflict('NOT_ELIGIBLE', 'This consultation is already completed or checked out and cannot be reopened for late check-in.');
        }
        if (appointment.status !== 'NO_SHOW') {
          throw conflict('NOT_ELIGIBLE', 'Only a manually marked no-show can be reopened for late check-in.');
        }
        if (appointment.appointmentDate !== today) {
          throw conflict('NOT_TODAY', 'Only today\'s no-show appointments can be reopened for late check-in.');
        }
        if (existing.status !== 'BOOKED' && existing.status !== 'CANCELLED') {
          throw conflict('NOT_ELIGIBLE', `This patient is ${existing.status.replace('_', ' ').toLowerCase()} and cannot be reopened for late check-in.`);
        }

        assertTransition('NO_SHOW', 'CONFIRMED');
        appointment.status = 'CONFIRMED';
        appointment.cancelReason = null;
        appointment.cancelledAt = null;
        appointment.cancelledByUserId = null;
        await manager.save(appointment);

        // Fresh check-in time so reopen joins the end of the waiting line (token unchanged).
        const checkInPatch = {
          checkedInAt: new Date(),
          checkedInByUserId: user.id,
          skippedAt: null,
          calledAt: null,
          calledByUserId: null,
          completedAt: null,
          completedByUserId: null,
          checkedOutAt: null,
          checkedOutByUserId: null,
        };
        await this.move(manager, existing, 'WAITING', user, checkInPatch);

        const position = positionOf(buildDay(await this.dayRows(manager, appointment.doctorId, today)), existing.id);
        await this.notifications.queueCheckedIn(manager, appointmentId, { entryId: existing.id, token: existing.tokenNumber, ahead: position?.ahead ?? 0 });
        return existing.id;
      });
      this.notifications.kick();
      return this.describe(entryId);
    });
  }

  /** Puts a skipped patient back in the queue with the token they had. Only for a patient whose appointment is still confirmed and today's. */
  async returnToQueue(user: AuthUser, entryId: string) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      const today = this.today();
      await this.dataSource.transaction(async (manager) => {
        const probe = await this.entryForAssignedDoctors(manager, entryId, doctorIds, false);
        await this.lockDoctor(manager, probe.doctorId);
        const entry = await this.lockEntry(manager, entryId);
        assertQueueTransition(entry.status, 'WAITING');
        if (entry.queueDate !== today) throw conflict('NOT_TODAY', 'Only a patient from today can be returned to the queue.');
        const appointment = await manager.findOneOrFail(Appointment, { where: { id: entry.appointmentId }, lock: { mode: 'pessimistic_write' } });
        if (appointment.status !== 'CONFIRMED') throw conflict('APPOINTMENT_NOT_ACTIVE', `This appointment is ${appointment.status.replace('_', ' ').toLowerCase()}, so the patient cannot be returned to the queue.`);
        // New check-in instant so Return joins the end of the wait line; original token is kept.
        await this.move(manager, entry, 'WAITING', user, {
          skippedAt: null,
          calledAt: null,
          calledByUserId: null,
          checkedInAt: new Date(),
          checkedInByUserId: user.id,
        });
      });
      return this.describe(entryId);
    });
  }

  /** The doctor's queue for a day, as the front desk sees it: every doctor who assigned this receptionist (or one of them). */
  async receptionBoard(user: AuthUser, query: { doctorId?: string; date?: string }) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      if (doctorIds.length === 0) return { date: query.date ?? this.today(), doctors: [] };
      const date = query.date ?? this.today();
      const doctors: { id: string; name: string; clinic_name: string }[] = await this.dataSource.query(
        `SELECT d.id, u.name, c.name AS clinic_name FROM doctors d JOIN users u ON u.id = d.user_id JOIN clinics c ON c.id = d.clinic_id
          WHERE d.id = ANY($1::uuid[]) ${query.doctorId ? 'AND d.id = $2' : ''} ORDER BY u.name`,
        query.doctorId ? [doctorIds, query.doctorId] : [doctorIds],
      );
      if (query.doctorId && doctors.length === 0) throw new NotFoundException('Doctor not found.');
      const boards = [];
      for (const doctor of doctors) boards.push({ doctor: { id: doctor.id, name: doctor.name, clinic: doctor.clinic_name }, ...this.dayView(buildDay(await this.dayRows(this.dataSource.manager, doctor.id, date)), date) });
      return { date, doctors: boards };
    });
  }

  // ---- Doctor ----

  /** The signed-in doctor's own queue for a day (today by default). */
  async doctorQueue(user: AuthUser, date?: string) {
    return this.guard(async () => {
      const doctor = await this.doctorOf(user);
      const day = date ?? this.today();
      const view = this.dayView(buildDay(await this.dayRows(this.dataSource.manager, doctor.id, day)), day);
      // Doctors never receive patient phone numbers (front desk only).
      const scrub = <T extends { patient: { name: string; phone?: string | null } }>(entry: T | null) =>
        entry ? { ...entry, patient: { name: entry.patient.name } } : null;
      return {
        doctor: { id: doctor.id, name: doctor.name },
        ...view,
        serving: scrub(view.serving),
        booked: view.booked.map((entry) => scrub(entry)!),
        waiting: view.waiting.map((entry) => scrub(entry)!),
        completed: view.completed.map((entry) => scrub(entry)!),
        checkedOut: view.checkedOut.map((entry) => scrub(entry)!),
        skipped: view.skipped.map((entry) => scrub(entry)!),
        cancelled: view.cancelled.map((entry) => scrub(entry)!),
      };
    });
  }

  /**
   * Calls the next waiting patient (the lowest token) as the one being served. Refused while a patient is still being served, so a
   * doctor can never have two current patients; a patient whose appointment was cancelled while being served is cleared away first.
   */
  async callNext(user: AuthUser) {
    return this.guard(async () => {
      const doctor = await this.doctorOf(user);
      const today = this.today();
      const outcome = await this.dataSource.transaction(async (manager) => {
        await this.lockDoctor(manager, doctor.id);
        const current = await manager.findOne(QueueEntry, { where: { doctorId: doctor.id, queueDate: today, status: 'SERVING' }, lock: { mode: 'pessimistic_write' } });
        let cleared = false;
        if (current) {
          const appointment = await manager.findOneOrFail(Appointment, { where: { id: current.appointmentId } });
          if (appointment.status === 'CONFIRMED') return { kind: 'busy' as const, token: current.tokenNumber };
          await this.move(manager, current, 'CANCELLED', user, {}); // its appointment was cancelled: it must not block the queue
          cleared = true;
        }
        // Earliest check-in first so late arrivals (and returns/reopens) never cut ahead of people already waiting.
        const [next]: { id: string }[] = await manager.query(
          `SELECT q.id FROM queue_entries q JOIN appointments a ON a.id = q.appointment_id
            WHERE q.doctor_id = $1 AND q.queue_date = $2 AND q.status = 'WAITING' AND a.status = 'CONFIRMED'
            ORDER BY q.checked_in_at ASC NULLS LAST, q.token_number ASC LIMIT 1 FOR UPDATE OF q`,
          [doctor.id, today],
        );
        if (!next) return { kind: 'empty' as const, cleared };
        const entry = await this.lockEntry(manager, next.id);
        await this.move(manager, entry, 'SERVING', user, { calledAt: new Date(), calledByUserId: user.id });
        await this.notifications.queueCalled(manager, entry.appointmentId, { entryId: entry.id, token: entry.tokenNumber });
        return { kind: 'called' as const, id: entry.id };
      });
      if (outcome.kind === 'busy') throw conflict('CURRENT_NOT_COMPLETED', `Complete the consultation for token ${outcome.token} before calling the next patient.`, { token: outcome.token });
      if (outcome.kind === 'empty') throw conflict('QUEUE_EMPTY', 'No patients are waiting.');
      this.notifications.kick();
      return this.describe(outcome.id);
    });
  }

  /** Completes the consultation of the patient being served; their appointment becomes COMPLETED. Doctors complete their own queue; receptionists may complete for assigned doctors. */
  async complete(user: AuthUser, entryId: string) {
    return this.guard(async () => {
      const doctorIds = user.role === 'RECEPTIONIST' ? await this.assignedDoctorIds(user) : [];
      const doctor = user.role === 'DOCTOR' ? await this.doctorOf(user) : null;
      const outcome = await this.dataSource.transaction(async (manager) => {
        const probe = await manager.findOneBy(QueueEntry, { id: entryId });
        if (!probe) throw new NotFoundException('Queue entry not found.');
        if (doctor) {
          if (probe.doctorId !== doctor.id) throw new NotFoundException('Queue entry not found.');
        } else {
          await this.entryForAssignedDoctors(manager, entryId, doctorIds, false);
        }
        await this.lockDoctor(manager, probe.doctorId);
        const entry = await this.lockEntry(manager, entryId);
        assertQueueTransition(entry.status, 'COMPLETED');
        const appointment = await manager.findOneOrFail(Appointment, { where: { id: entry.appointmentId }, lock: { mode: 'pessimistic_write' } });
        if (appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW') {
          await this.move(manager, entry, 'CANCELLED', user, {});
          return 'cancelled' as const;
        }
        await this.move(manager, entry, 'COMPLETED', user, { completedAt: new Date(), completedByUserId: user.id });
        if (appointment.status === 'CONFIRMED') {
          assertTransition('CONFIRMED', 'COMPLETED');
          await manager.update(Appointment, { id: appointment.id }, { status: 'COMPLETED' });
        }
        return 'completed' as const;
      });
      if (outcome === 'cancelled') throw conflict('APPOINTMENT_CANCELLED', 'This appointment was cancelled, so the consultation cannot be completed. The patient has been removed from the queue.');
      return this.describe(entryId);
    });
  }

  // ---- Receptionist or doctor ----

  /** Skips a waiting patient, or one who was called but is not there. The appointment itself is left as it is. */
  async skip(user: AuthUser, entryId: string) {
    return this.guard(async () => {
      const doctorIds = user.role === 'RECEPTIONIST' ? await this.assignedDoctorIds(user) : [];
      const doctor = user.role === 'DOCTOR' ? await this.doctorOf(user) : null;
      await this.dataSource.transaction(async (manager) => {
        const probe = await manager.findOneBy(QueueEntry, { id: entryId });
        if (!probe) throw new NotFoundException('Queue entry not found.');
        if (doctor) {
          if (probe.doctorId !== doctor.id) throw new NotFoundException('Queue entry not found.');
        } else {
          await this.entryForAssignedDoctors(manager, entryId, doctorIds, false);
        }
        await this.lockDoctor(manager, probe.doctorId);
        const entry = await this.lockEntry(manager, entryId);
        await this.move(manager, entry, 'SKIPPED', user, { skippedAt: new Date() });
      });
      return this.describe(entryId);
    });
  }

  // ---- Patient ----

  /** The signed-in patient's own place in today's queue (includes BOOKED tokens reserved at booking). Nobody else's details are included. */
  async myQueue(user: AuthUser) {
    return this.guard(async () => {
      const patient = await this.dataSource.getRepository(Patient).findOne({ where: { userId: user.id }, select: { id: true } });
      if (!patient) throw new ForbiddenException('Only patients have a queue position.');
      const today = this.today();
      const mine: { id: string; doctor_id: string }[] = await this.dataSource.query('SELECT id, doctor_id FROM queue_entries WHERE patient_id = $1 AND queue_date = $2 ORDER BY token_number', [patient.id, today]);
      const days = new Map<string, Day<QueueRow>>();
      const result = [];
      for (const entry of mine) {
        if (!days.has(entry.doctor_id)) days.set(entry.doctor_id, buildDay(await this.dayRows(this.dataSource.manager, entry.doctor_id, today)));
        const day = days.get(entry.doctor_id)!;
        const all = [day.serving, ...day.waiting, ...day.booked, ...day.completed, ...day.checkedOut, ...day.skipped, ...day.cancelled];
        const row = all.find((candidate) => candidate?.id === entry.id);
        const position = positionOf(day, entry.id);
        if (!row || !position) continue;
        // Only this patient's own entry: the others in the queue appear only as counts.
        result.push({
          id: row.id,
          appointmentId: row.appointmentId,
          queueDate: row.queueDate,
          token: row.token,
          status: position.status,
          doctor: { id: row.doctorId, name: row.doctorName },
          appointment: { startTime: row.startTime, endTime: row.endTime },
          currentlyServingToken: position.currentlyServingToken,
          ahead: position.ahead,
          behind: position.behind,
          checkedInAt: row.checkedInAt?.toISOString() ?? null,
          calledAt: row.calledAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          checkedOutAt: row.checkedOutAt?.toISOString() ?? null,
          updatedAt: new Date().toISOString(),
        });
      }
      return result;
    });
  }

  // ---- Admin ----

  /** Every doctor's queue for a day as counts and tokens only: no patient names. */
  async adminBoard(date?: string) {
    return this.guard(async () => {
      const day = date ?? this.today();
      const rows: {
        doctor_id: string; doctor_name: string; clinic_name: string; waiting: number; serving: number; completed: number; checked_out: number; skipped: number; cancelled: number; serving_token: number | null; last_token: number;
      }[] = await this.dataSource.query(
        `SELECT d.id AS doctor_id, du.name AS doctor_name, c.name AS clinic_name,
                count(*) FILTER (WHERE q.status = 'WAITING' AND a.status = 'CONFIRMED')::int AS waiting,
                count(*) FILTER (WHERE q.status = 'SERVING' AND a.status = 'CONFIRMED')::int AS serving,
                count(*) FILTER (WHERE q.status = 'COMPLETED')::int AS completed,
                count(*) FILTER (WHERE q.status = 'CHECKED_OUT')::int AS checked_out,
                count(*) FILTER (WHERE q.status = 'SKIPPED' AND a.status = 'CONFIRMED')::int AS skipped,
                count(*) FILTER (WHERE q.status = 'CANCELLED' OR (q.status IN ('BOOKED', 'WAITING', 'SERVING', 'SKIPPED') AND a.status IN ('CANCELLED', 'NO_SHOW')))::int AS cancelled,
                min(q.token_number) FILTER (WHERE q.status = 'SERVING' AND a.status = 'CONFIRMED') AS serving_token,
                max(q.token_number)::int AS last_token
           FROM queue_entries q JOIN appointments a ON a.id = q.appointment_id JOIN doctors d ON d.id = q.doctor_id
           JOIN users du ON du.id = d.user_id JOIN clinics c ON c.id = d.clinic_id
          WHERE q.queue_date = $1 GROUP BY d.id, du.name, c.name ORDER BY c.name, du.name`,
        [day],
      );
      return {
        date: day,
        doctors: rows.map((row) => ({
          doctor: { id: row.doctor_id, name: row.doctor_name },
          clinic: row.clinic_name,
          currentlyServingToken: row.serving_token === null ? null : Number(row.serving_token),
          lastTokenIssued: Number(row.last_token),
          counts: { waiting: row.waiting, serving: row.serving, completed: row.completed, checkedOut: row.checked_out, skipped: row.skipped, cancelled: row.cancelled },
          status: row.serving > 0 ? 'SERVING' : row.waiting > 0 ? 'WAITING' : 'IDLE',
        })),
      };
    });
  }

  // ---- internals ----

  private today(): string {
    return clinicNow(this.config.clinicTimezone).date;
  }

  /** Turns "the queue tables do not exist yet" into a clear 503, so a database that has not been migrated fails plainly and only here. */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isMissingQueueTable(error)) throw new ServiceUnavailableException('Queue management is not available yet: the database has not been updated (migration 015).');
      throw error;
    }
  }

  /** Doctors who have assigned this receptionist (empty when none have). */
  private async assignedDoctorIds(user: AuthUser): Promise<string[]> {
    const rows = await this.dataSource.getRepository(DoctorReceptionistAssignment).find({ where: { receptionistUserId: user.id } });
    return rows.map((row) => row.doctorId);
  }

  private async doctorOf(user: AuthUser): Promise<{ id: string; name: string }> {
    const doctor = await this.dataSource.getRepository(Doctor).findOne({ where: { userId: user.id }, relations: { user: true } });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return { id: doctor.id, name: doctor.user.name };
  }

  private async lockDoctor(manager: EntityManager, doctorId: string): Promise<void> {
    await manager.findOne(Doctor, { where: { id: doctorId }, lock: { mode: 'pessimistic_write' } });
  }

  private async lockEntry(manager: EntityManager, id: string): Promise<QueueEntry> {
    const entry = await manager.findOne(QueueEntry, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!entry) throw new NotFoundException('Queue entry not found.');
    return entry;
  }

  /** The entry, if its doctor assigned this receptionist; someone else's looks like a missing one. */
  private async entryForAssignedDoctors(manager: EntityManager, id: string, doctorIds: string[], lock = true): Promise<QueueEntry> {
    const entry = lock ? await this.lockEntry(manager, id) : await manager.findOneBy(QueueEntry, { id });
    if (!entry || !doctorIds.includes(entry.doctorId)) throw new NotFoundException('Queue entry not found.');
    return entry;
  }

  /**
   * Repairs a visit that background auto-complete wrongly marked COMPLETED while the queue token stayed BOOKED (never checked in,
   * never consulted). Restores CONFIRMED so Late Arrival and manual No Show can proceed with the original token. Does not reopen
   * real completed consultations (queue already COMPLETED / CHECKED_OUT / checked in).
   */
  private async restoreMistakenCompletionIfNeverArrived(
    manager: EntityManager,
    appointment: Appointment,
    entry: QueueEntry,
    _actor: AuthUser,
  ): Promise<void> {
    if (appointment.status !== 'COMPLETED') return;
    if (entry.status !== 'BOOKED' || entry.checkedInAt != null || entry.completedAt != null) {
      throw conflict('NOT_ELIGIBLE', 'This appointment is completed, so the patient cannot be checked in or marked no-show.');
    }
    // Appointment-only repair: queue row never left BOOKED, so there is no status transition to audit here.
    appointment.status = 'CONFIRMED';
    try {
      await manager.save(appointment);
    } catch (error) {
      const code = (error as { code?: unknown; driverError?: { code?: unknown } }).code ?? (error as { driverError?: { code?: unknown } }).driverError?.code;
      if (code === '23505') {
        throw conflict(
          'SLOT_TAKEN',
          'This visit was marked completed earlier and its original slot is now taken by another booking. Reschedule the patient, then check them in with their existing token.',
        );
      }
      throw error;
    }
  }

  /** One checked, recorded change of status. */
  private async move(manager: EntityManager, entry: QueueEntry, to: QueueStatus, actor: AuthUser, patch: Partial<QueueEntry>): Promise<void> {
    const from = entry.status;
    assertQueueTransition(from, to);
    Object.assign(entry, patch, { status: to });
    await manager.save(entry);
    await this.record(manager, entry.id, from, to, actor);
  }

  private async record(manager: EntityManager, entryId: string, from: QueueStatus | null, to: QueueStatus, actor: AuthUser): Promise<void> {
    await manager.insert(QueueEvent, { entryId, event: eventFor(from, to), fromStatus: from, toStatus: to, actorUserId: actor.id });
  }

  /** Every entry of one doctor's day with its appointment's own status, read fresh each time. */
  private async dayRows(manager: EntityManager, doctorId: string, date: string): Promise<QueueRow[]> {
    const rows: Record<string, unknown>[] = await manager.query(
      `SELECT q.id, q.appointment_id, q.doctor_id, du.name AS doctor_name, q.queue_date::text AS queue_date, q.token_number, q.status,
              q.checked_in_at, q.called_at, q.completed_at, q.checked_out_at, q.updated_at,
              a.status::text AS appointment_status, a.start_time::text AS start_time, a.end_time::text AS end_time,
              pu.name AS patient_name, p.phone AS patient_phone
         FROM queue_entries q
         JOIN appointments a ON a.id = q.appointment_id
         JOIN doctors d ON d.id = q.doctor_id JOIN users du ON du.id = d.user_id
         JOIN patients p ON p.id = q.patient_id JOIN users pu ON pu.id = p.user_id
        WHERE q.doctor_id = $1 AND q.queue_date = $2
        ORDER BY q.token_number`,
      [doctorId, date],
    );
    return rows.map((row) => ({
      id: row.id as string,
      token: Number(row.token_number),
      status: row.status as QueueStatus,
      appointmentStatus: row.appointment_status as string,
      appointmentId: row.appointment_id as string,
      doctorId: row.doctor_id as string,
      doctorName: row.doctor_name as string,
      queueDate: row.queue_date as string,
      startTime: hhmm(row.start_time as string),
      endTime: hhmm(row.end_time as string),
      patientName: row.patient_name as string,
      patientPhone: (row.patient_phone as string | null) ?? null,
      checkedInAt: (row.checked_in_at as Date | null) ?? null,
      calledAt: row.called_at as Date | null,
      completedAt: row.completed_at as Date | null,
      checkedOutAt: row.checked_out_at as Date | null,
      updatedAt: row.updated_at as Date,
    }));
  }

  private entryView(row: QueueRow) {
    return {
      id: row.id,
      appointmentId: row.appointmentId,
      token: row.token,
      status: row.status,
      appointmentStatus: row.appointmentStatus,
      appointment: { startTime: row.startTime, endTime: row.endTime },
      patient: { name: row.patientName, phone: row.patientPhone },
      checkedInAt: row.checkedInAt?.toISOString() ?? null,
      calledAt: row.calledAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      checkedOutAt: row.checkedOutAt?.toISOString() ?? null,
    };
  }

  /** A whole day for the doctor's and the front desk's screens. */
  private dayView(day: Day<QueueRow>, date: string) {
    return {
      date,
      currentlyServingToken: day.currentlyServingToken,
      serving: day.serving ? this.entryView(day.serving) : null,
      booked: day.booked.map((row) => this.entryView(row)),
      waiting: day.waiting.map((row, index) => ({ ...this.entryView(row), position: index + 1 })),
      completed: day.completed.map((row) => this.entryView(row)),
      checkedOut: day.checkedOut.map((row) => this.entryView(row)),
      skipped: day.skipped.map((row) => this.entryView(row)),
      cancelled: day.cancelled.map((row) => this.entryView(row)),
      counts: {
        booked: day.booked.length,
        waiting: day.waiting.length,
        serving: day.serving ? 1 : 0,
        completed: day.completed.length,
        checkedOut: day.checkedOut.length,
        skipped: day.skipped.length,
        cancelled: day.cancelled.length,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  /** One entry after a change: its status and its place in the line, from the live entries. */
  private async describe(entryId: string) {
    const [located]: { doctor_id: string; queue_date: string }[] = await this.dataSource.query('SELECT doctor_id, queue_date::text AS queue_date FROM queue_entries WHERE id = $1', [entryId]);
    if (!located) throw new NotFoundException('Queue entry not found.');
    const day = buildDay(await this.dayRows(this.dataSource.manager, located.doctor_id, located.queue_date));
    const all = [day.serving, ...day.waiting, ...day.booked, ...day.completed, ...day.checkedOut, ...day.skipped, ...day.cancelled];
    const row = all.find((candidate) => candidate?.id === entryId)!;
    const position = positionOf(day, entryId)!;
    return { ...this.entryView(row), queueDate: row.queueDate, doctor: { id: row.doctorId, name: row.doctorName }, currentlyServingToken: position.currentlyServingToken, ahead: position.ahead, behind: position.behind };
  }
}
