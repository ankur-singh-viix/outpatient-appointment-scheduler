import { BadGatewayException, BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { AppointmentsService } from '../../appointments/appointments.service.js';
import type { AuthUser } from '../../auth/auth.types.js';
import { zonedInstant } from '../../common/zoned-time.js';
import { loadConfig } from '../../config.js';
import { AssistantAction } from '../../database/entities/index.js';
import type { AssistantActionKind } from '../../database/entities/assistant-action.entity.js';
import { DoctorsService } from '../../doctors/doctors.service.js';
import { PaymentsService } from '../../payments/payments.service.js';
import { refundFor } from '../../payments/refund-policy.js';
import { changeBlockedReason } from '../../scheduling/appointment-rules.js';
import { clinicNow } from '../../scheduling/calendar.js';
import { loadDaySchedule } from '../../scheduling/day-schedule.js';
import { dateLabel, rangeLabel, rupees, timeLabel, type ActionCard } from './action-cards.js';

/** What a preparation hands back: the card for the patient's screen, and a short note for the model (never the confirmation reference). */
export interface Prepared {
  card: ActionCard;
  forModel: Record<string, unknown>;
}

/** An appointment as My Appointments shows it. */
export type PatientAppointmentRow = Awaited<ReturnType<AppointmentsService['listForPatient']>>[number];

/** What a confirmation did, in the server's own words. Shown to the patient; nothing here is written by the model. */
export interface ActionResult {
  kind: AssistantActionKind;
  /** DONE: the change is made. PAYMENT_REQUIRED: a booking is held but not confirmed until the payment is verified. */
  outcome: 'DONE' | 'PAYMENT_REQUIRED';
  message: string;
  /** The appointment as the rest of the app shows it (this is what My Appointments lists). */
  appointment: Awaited<ReturnType<AppointmentsService['book']>>;
  /** Present only while a booking waits for payment: what the existing secure Razorpay Checkout needs. No secret. */
  checkout?: unknown;
}

/**
 * Where a prepared action stands, as the patient is told. The stored status is coarser (PREPARED, CONFIRMING, DONE, FAILED, DISMISSED);
 * these say what is TRUE of the appointment data.
 *  - IN_PROGRESS: confirmed a moment ago and still running (or just interrupted: not yet safe to say which).
 *  - NOT_APPLIED: the records show it did not happen, and nothing was repeated.
 *  - UNCERTAIN: the records do not settle it. Nothing is repeated; the appointment data (My Appointments) is the source of truth.
 */
export type ActionState = 'PREPARED' | 'IN_PROGRESS' | 'DONE' | 'NOT_APPLIED' | 'FAILED' | 'DISMISSED' | 'EXPIRED' | 'UNCERTAIN';

export interface ActionStatus {
  ref: string;
  kind: AssistantActionKind;
  state: ActionState;
  message: string;
  /** The appointment the action produced or concerns, once the records show one. */
  appointment?: PatientAppointmentRow;
  /** Present for UNCERTAIN: where the patient can see the real state. */
  reconcileWith?: string;
}

/**
 * How long a confirmed action may take before an interrupted one can be judged. A confirmation runs one short booking transaction, so
 * anything older than this has either finished, been rolled back, or died with its process. Judging earlier would risk calling a
 * slow-but-running action "not applied".
 */
export const RECOVERY_GRACE_SECONDS = 120;

/**
 * A new appointment's created_at is stamped by the database (the same clock as the claim), but a cancellation's cancelled_at is stamped by
 * the application. Those two clocks are never exactly equal, so cancellation times are compared with this much allowance on each side
 * rather than to the millisecond. (It is wide on purpose: the cancellation is also required to be by this same patient.)
 */
export const CLOCK_SKEW_SECONDS = 300;

const RECOVERED = 'Recovered after an interruption: ';
const EXPIRED = 'This confirmation expired. Ask me again and I will prepare it afresh.';
const USED = 'This confirmation was already used or closed, so nothing more was done.';
const UNCERTAIN_NOW = 'We could not confirm whether this went through. Nothing has been repeated. Check the status here, or open My Appointments to see what really happened.';
const MODEL_INSTRUCTION =
  'A confirmation card is now on the patient\'s screen. You cannot confirm it and nothing has happened yet. Tell the patient to review the details and press Confirm (or Cancel). Never say it is booked, moved or cancelled.';

/** What the records show about an action whose outcome was not recorded. */
type Evidence = { found: 'APPLIED'; appointmentId: string } | { found: 'ABSENT'; why: string } | { found: 'UNCERTAIN'; why: string };
type Reconciled = { state: 'DONE'; appointmentId: string } | { state: 'NOT_APPLIED'; why: string } | { state: 'IN_PROGRESS' } | { state: 'UNCERTAIN'; why: string };

/**
 * Prepares and carries out the assistant's three actions for a patient: book, reschedule and cancel. Preparation only reads; the one
 * place anything changes is `confirm`, which the patient's button calls with a reference the server issued.
 *
 * Every real change goes through the existing AppointmentsService (the same transaction, doctor lock, capacity, duplicate, refund and
 * notification rules as the booking pages), with the SIGNED-IN user, and with the parameters stored when the action was prepared. The
 * model's arguments are used once, to build a card the patient can read; they are never executed directly.
 *
 * Interrupted confirmations. The single-use claim (PREPARED to CONFIRMING) is atomic, but the claim and the booking are two separate
 * database transactions, so a crash between them (or just after the booking commits) leaves an action stuck in CONFIRMING. This is NOT
 * exactly-once execution, and it never re-runs a change. Instead it RECONCILES: the booking services are each one all-or-nothing
 * transaction, so the appointment data itself shows whether the change happened (a new appointment, a rescheduled-from link, a
 * cancellation stamped after the claim). Evidence of success is believed at once; evidence of absence only after RECOVERY_GRACE_SECONDS;
 * anything the data cannot settle is reported as UNCERTAIN and left for the patient to check in My Appointments. To try again the
 * patient prepares and confirms a new card, which the existing duplicate and capacity rules guard as always.
 */
@Injectable()
export class AssistantActionsService {
  private readonly logger = new Logger(AssistantActionsService.name);
  private readonly config = loadConfig();
  private readonly actions: Repository<AssistantAction>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly appointments: AppointmentsService,
    private readonly doctors: DoctorsService,
    private readonly payments: PaymentsService,
  ) {
    this.actions = dataSource.getRepository(AssistantAction);
  }

  // ------------------------------------------------------------------ prepare (read-only)

  async prepareBooking(user: AuthUser, input: { doctorId: string; date: string; startTime: string }): Promise<Prepared> {
    const doctor = await this.doctors.get(input.doctorId);
    const slot = await this.openSlot(input.doctorId, input.date, input.startTime, doctor.name);
    const online = this.payments.publicConfig();
    const fee = doctor.consultationFee;
    const charge = fee <= 0 ? 'No charge' : online.enabled ? `${rupees(fee * 100)}, paid online after you confirm` : `${rupees(fee * 100)}, payable at the clinic`;
    return this.issue(user, 'BOOK', input, {
      title: 'Book this appointment?',
      lines: [
        { label: 'Doctor', value: `${doctor.name} (${doctor.specialty.name})` },
        { label: 'Clinic', value: `${doctor.clinic.name}, ${doctor.clinic.address}` },
        { label: 'Date', value: dateLabel(input.date) },
        { label: 'Time', value: rangeLabel(slot.startTime, slot.endTime) },
        { label: 'Fee', value: charge },
      ],
      note: fee > 0 && online.enabled ? `The slot is held for ${online.holdMinutes} minutes while you pay. The appointment is confirmed only once the payment is verified.` : undefined,
      confirmLabel: 'Confirm booking',
      dismissLabel: 'Cancel',
    });
  }

  async prepareReschedule(user: AuthUser, input: { appointmentId: string; date: string; startTime: string }): Promise<Prepared> {
    const current = await this.ownAppointment(user, input.appointmentId);
    this.assertChangeable(current);
    if (current.status === 'PENDING') throw new ConflictException('Finish paying for this booking, or cancel it, before rescheduling.');
    if (current.date === input.date && current.startTime === input.startTime) throw new BadRequestException('That is the time the appointment already has. Choose a different slot.');
    // The move releases the old time first, so the target is judged as if the appointment being moved were not there.
    const slot = await this.openSlot(current.doctor.id, input.date, input.startTime, current.doctor.name, current.id);
    const paid = current.payment?.status === 'PAID';
    return this.issue(user, 'RESCHEDULE', input, {
      title: 'Move this appointment?',
      lines: [
        { label: 'Doctor', value: `${current.doctor.name} (${current.doctor.specialty})` },
        { label: 'Now', value: `${dateLabel(current.date)}, ${rangeLabel(current.startTime, current.endTime)}` },
        { label: 'Move to', value: `${dateLabel(input.date)}, ${rangeLabel(slot.startTime, slot.endTime)}` },
      ],
      note: paid ? 'Your payment moves with the appointment: no refund and no second charge.' : 'Your current appointment stays booked until the move succeeds.',
      confirmLabel: 'Confirm move',
      dismissLabel: 'Keep my appointment',
    });
  }

  async prepareCancellation(user: AuthUser, input: { appointmentId: string }): Promise<Prepared> {
    const current = await this.ownAppointment(user, input.appointmentId);
    this.assertChangeable(current);
    return this.issue(user, 'CANCEL', input, {
      title: 'Cancel this appointment?',
      lines: [
        { label: 'Doctor', value: `${current.doctor.name} (${current.doctor.specialty})` },
        { label: 'When', value: `${dateLabel(current.date)}, ${rangeLabel(current.startTime, current.endTime)}` },
        { label: 'Refund', value: this.refundText(current) },
      ],
      note: 'This cannot be undone. The refund (if any) is worked out under the clinic policy at the moment you confirm.',
      confirmLabel: 'Cancel appointment',
      dismissLabel: 'Keep my appointment',
    });
  }

  // ------------------------------------------------------------------ confirm (the only place anything changes)

  /**
   * Runs a prepared action for the signed-in patient. The reference is claimed with one atomic UPDATE (PREPARED to CONFIRMING, for this
   * user, before it expires), so a second click, a second tab or a replay finds nothing to claim and does nothing. After the claim the
   * stored parameters run through the existing service, which re-checks ownership, the slot, capacity and every rule under its own locks.
   *
   * How an ending is recorded matters for recovery:
   *  - the service answers with an HttpException: it has decided and rolled back, so "no" is certain and the action is marked FAILED;
   *  - anything else (a dropped connection, a crash): the outcome is UNKNOWN, so nothing is claimed either way, the action stays
   *    CONFIRMING, and the records are consulted (a change that did commit is found and reported as done at once);
   *  - success: the action is marked DONE. If that last write itself fails the result is still returned (it is known), and the stuck
   *    CONFIRMING row is later settled from the records.
   */
  async confirm(user: AuthUser, ref: string): Promise<ActionResult> {
    if (!(await this.close(user, ref, 'CONFIRMING'))) throw await this.whyNotClaimable(user, ref);
    const action = await this.actions.findOneByOrFail({ id: ref });
    let result: ActionResult;
    try {
      result = await this.run(user, action);
    } catch (error) {
      if (error instanceof HttpException) {
        const message = error.getStatus() < 500 ? error.message : 'Something went wrong, so nothing was changed. Please try again.';
        await this.settle(ref, 'FAILED', message);
        throw error.getStatus() < 500 ? error : new BadGatewayException(message);
      }
      this.logger.error(`Assistant ${action.kind} was interrupted (${error instanceof Error ? error.name : 'error'}); checking the records.`);
      const found = await this.reconcile(action).catch(() => null);
      if (found?.state === 'DONE') return this.resultFor(action.kind, await this.appointmentFor(user, found.appointmentId), true);
      throw new HttpException({ statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', code: 'ACTION_UNCERTAIN', message: UNCERTAIN_NOW }, HttpStatus.BAD_GATEWAY);
    }
    try {
      await this.actions.update({ id: ref, status: 'CONFIRMING' }, { status: 'DONE', resultAppointmentId: result.appointment.id });
    } catch (error) {
      this.logger.warn(`Assistant ${action.kind} succeeded but could not be marked done (${error instanceof Error ? error.name : 'error'}); it will be settled from the records.`);
    }
    return result;
  }

  /** The patient pressed Cancel on the card: it can no longer be confirmed. */
  async dismiss(user: AuthUser, ref: string): Promise<{ status: 'DISMISSED' }> {
    if (!(await this.close(user, ref, 'DISMISSED'))) throw await this.whyNotClaimable(user, ref);
    return { status: 'DISMISSED' };
  }

  // ------------------------------------------------------------------ status and recovery

  /**
   * Where a patient's own action stands. An action that was confirmed and never finished is reconciled here, from the appointment data
   * (see the class note); nothing is ever re-run. Another patient's reference is "not found".
   */
  async status(user: AuthUser, ref: string): Promise<ActionStatus> {
    const row = await this.actions.findOneBy({ id: ref, userId: user.id });
    if (!row) throw new NotFoundException('That confirmation was not found.');
    const base = { ref: row.id, kind: row.kind };
    switch (row.status) {
      case 'DISMISSED':
        return { ...base, state: 'DISMISSED', message: 'You cancelled this, so nothing was changed.' };
      case 'PREPARED':
        return row.expiresAt.getTime() > Date.now() ? { ...base, state: 'PREPARED', message: 'Waiting for you to confirm.' } : { ...base, state: 'EXPIRED', message: EXPIRED };
      case 'DONE':
        return this.doneStatus(user, row, row.resultAppointmentId);
      case 'FAILED':
        if (!row.failure?.startsWith(RECOVERED)) return { ...base, state: 'FAILED', message: `${row.failure ?? 'It was not done.'} Nothing was changed.` };
        break; // a failure concluded from the records: look once more, in case a slow commit landed after the conclusion
    }
    const found = await this.reconcile(row);
    if (found.state === 'DONE') return this.doneStatus(user, row, found.appointmentId, true);
    if (found.state === 'IN_PROGRESS') return { ...base, state: 'IN_PROGRESS', message: 'This is still being processed. Nothing has been repeated. Check again in a moment.' };
    if (found.state === 'UNCERTAIN') return { ...base, state: 'UNCERTAIN', message: `${found.why} We have not repeated anything. Open My Appointments to see what really happened.`, reconcileWith: 'My Appointments' };
    return { ...base, state: 'NOT_APPLIED', message: `${found.why} Nothing was changed and nothing was repeated. Ask me again if you still want it.` };
  }

  /**
   * Settles confirmed actions that never finished (the process died, or the last write failed), so none stays CONFIRMING for ever.
   * Reconcile-only: it reads the appointment data and records what it finds; it never runs a booking. Safe on two servers at once.
   */
  async reconcileStuck(limit = 50): Promise<number> {
    const stuck = await this.actions
      .createQueryBuilder('a')
      .where("a.status = 'CONFIRMING' AND a.decided_at < now() - make_interval(secs => :grace)", { grace: RECOVERY_GRACE_SECONDS })
      .orderBy('a.decided_at', 'ASC')
      .limit(limit)
      .getMany();
    let settled = 0;
    for (const row of stuck) {
      try {
        const found = await this.reconcile(row);
        if (found.state === 'DONE' || found.state === 'NOT_APPLIED') settled++;
      } catch (error) {
        this.logger.warn(`Could not reconcile assistant action ${row.id} (${error instanceof Error ? error.name : 'error'}).`);
      }
    }
    return settled;
  }

  /**
   * Decides, from the appointment data, what became of a confirmed action, and records it. Success is recorded at once. Absence is only
   * concluded after RECOVERY_GRACE_SECONDS (before that the action may simply still be running). A conclusion of absence is itself
   * revisited by status(), so a very slow commit that lands afterwards is still found and shown. Writes only ever change a row that is
   * still CONFIRMING (or a recovered failure), so two reconcilers cannot disagree.
   */
  private async reconcile(row: AssistantAction): Promise<Reconciled> {
    const found = await this.evidence(row);
    if (found.found === 'APPLIED') {
      await this.actions
        .createQueryBuilder()
        .update(AssistantAction)
        .set({ status: 'DONE', resultAppointmentId: found.appointmentId, failure: null })
        .where("id = :id AND (status = 'CONFIRMING' OR (status = 'FAILED' AND failure LIKE :recovered))", { id: row.id, recovered: `${RECOVERED}%` })
        .execute();
      return { state: 'DONE', appointmentId: found.appointmentId };
    }
    if (found.found === 'UNCERTAIN') return { state: 'UNCERTAIN', why: found.why };
    if (row.status === 'FAILED') return { state: 'NOT_APPLIED', why: found.why };
    const [{ age }] = (await this.dataSource.query('SELECT EXTRACT(EPOCH FROM (now() - decided_at))::float8 AS age FROM assistant_actions WHERE id = $1', [row.id])) as { age: number }[];
    if (age < RECOVERY_GRACE_SECONDS) return { state: 'IN_PROGRESS' };
    await this.actions
      .createQueryBuilder()
      .update(AssistantAction)
      .set({ status: 'FAILED', failure: `${RECOVERED}${found.why}` })
      .where("id = :id AND status = 'CONFIRMING'", { id: row.id })
      .execute();
    return { state: 'NOT_APPLIED', why: found.why };
  }

  /**
   * What the appointment data says about an action, using the moment it was claimed (decided_at, the database's own clock) as the line
   * between "before" and "after". Each booking service is one all-or-nothing transaction, so these traces are either all there or none.
   */
  private async evidence(row: AssistantAction): Promise<Evidence> {
    const p = row.params;
    const query = <T>(sql: string, params: unknown[]) => this.dataSource.query(sql, params) as Promise<T[]>;
    // The window in which this action's own change could have been made: from the claim until the longest a run can last. An appointment
    // made well after that (say a fresh booking of the same slot) belongs to something else and is never mistaken for this action.
    const claimed = '(SELECT decided_at FROM assistant_actions WHERE id = $1)';
    const windowEnd = `(SELECT decided_at + interval '${RECOVERY_GRACE_SECONDS} seconds' FROM assistant_actions WHERE id = $1)`;
    // cancelled_at comes from the application's clock, so it is judged with an allowance for clock skew (see CLOCK_SKEW_SECONDS).
    const cancelledInWindow = `(a.cancelled_at >= ${claimed} - interval '${CLOCK_SKEW_SECONDS} seconds' AND a.cancelled_at < ${windowEnd} + interval '${CLOCK_SKEW_SECONDS} seconds')`;
    if (row.kind === 'BOOK') {
      const [made] = await query<{ id: string }>(
        `SELECT a.id FROM appointments a JOIN patients pt ON pt.id = a.patient_id
          WHERE pt.user_id = $2 AND a.doctor_id = $3 AND a.appointment_date = $4 AND a.start_time = $5::time AND a.created_at >= ${claimed} AND a.created_at < ${windowEnd}
          ORDER BY a.created_at DESC LIMIT 1`,
        [row.id, row.userId, p.doctorId, p.date, p.startTime],
      );
      return made ? { found: 'APPLIED', appointmentId: made.id } : { found: 'ABSENT', why: 'No appointment was created for this booking.' };
    }
    if (row.kind === 'RESCHEDULE') {
      const [moved] = await query<{ id: string }>(
        `SELECT a.id FROM appointments a JOIN patients pt ON pt.id = a.patient_id
          WHERE a.rescheduled_from_id = $3 AND pt.user_id = $2 AND a.created_at >= ${claimed} AND a.created_at < ${windowEnd} LIMIT 1`,
        [row.id, row.userId, p.appointmentId],
      );
      if (moved) return { found: 'APPLIED', appointmentId: moved.id };
      const [old] = await query<{ status: string; cancel_reason: string | null; after: boolean | null }>(
        `SELECT a.status::text AS status, a.cancel_reason, ${cancelledInWindow} AS after FROM appointments a JOIN patients pt ON pt.id = a.patient_id WHERE a.id = $3 AND pt.user_id = $2`,
        [row.id, row.userId, p.appointmentId],
      );
      if (!old) return { found: 'ABSENT', why: 'The appointment could not be found, so nothing was moved.' };
      if (old.status === 'CANCELLED' && old.cancel_reason === 'Rescheduled by patient' && old.after) {
        return { found: 'UNCERTAIN', why: 'The old time was released, but the new appointment could not be found.' };
      }
      return { found: 'ABSENT', why: 'The appointment is unchanged, so it was not moved.' };
    }
    const [target] = await query<{ id: string; status: string; cancelled_by_user_id: string | null; after: boolean | null }>(
      `SELECT a.id, a.status::text AS status, a.cancelled_by_user_id, ${cancelledInWindow} AS after FROM appointments a JOIN patients pt ON pt.id = a.patient_id WHERE a.id = $3 AND pt.user_id = $2`,
      [row.id, row.userId, p.appointmentId],
    );
    if (!target) return { found: 'ABSENT', why: 'The appointment could not be found, so nothing was cancelled.' };
    if (target.status === 'CANCELLED' && target.after) {
      return target.cancelled_by_user_id === row.userId
        ? { found: 'APPLIED', appointmentId: target.id }
        : { found: 'UNCERTAIN', why: 'The appointment was cancelled just then, but not by you, so this request may not be what cancelled it.' };
    }
    return { found: 'ABSENT', why: `The appointment is still ${target.status.toLowerCase().replace('_', ' ')}, so it was not cancelled by this request.` };
  }

  private async doneStatus(user: AuthUser, row: AssistantAction, appointmentId: string | null, recovered = false): Promise<ActionStatus> {
    const appointment = appointmentId ? await this.appointmentFor(user, appointmentId).catch(() => undefined) : undefined;
    const base = { ref: row.id, kind: row.kind, state: 'DONE' as const };
    if (!appointment) return { ...base, message: 'It went through. Open My Appointments to see it.' };
    return { ...base, message: `${recovered ? 'It went through even though the connection was interrupted. ' : ''}${this.describe(row.kind, appointment)}`, appointment };
  }

  // ------------------------------------------------------------------ helpers

  private async run(user: AuthUser, action: AssistantAction): Promise<ActionResult> {
    const p = action.params;
    if (action.kind === 'BOOK') {
      const booked = await this.appointments.book(user, { doctorId: p.doctorId, date: p.date, startTime: p.startTime });
      return { ...this.resultFor('BOOK', booked), ...('checkout' in booked && booked.checkout ? { checkout: booked.checkout } : {}) };
    }
    if (action.kind === 'RESCHEDULE') return this.resultFor('RESCHEDULE', await this.appointments.reschedule(user, p.appointmentId, { date: p.date, startTime: p.startTime }));
    return this.resultFor('CANCEL', await this.appointments.cancel(user, p.appointmentId));
  }

  private resultFor(kind: AssistantActionKind, appointment: ActionResult['appointment'], recovered = false): ActionResult {
    const held = kind === 'BOOK' && appointment.status === 'PENDING';
    return {
      kind,
      outcome: held ? 'PAYMENT_REQUIRED' : 'DONE',
      message: `${recovered ? 'It went through even though the connection was interrupted. ' : ''}${this.describe(kind, appointment)}`,
      appointment,
    };
  }

  /** The server's own words for what the records show. It states the appointment's real status, never more. */
  private describe(kind: AssistantActionKind, appointment: Omit<PatientAppointmentRow, 'needsNewTime'>): string {
    const where = `${appointment.doctor.name} on ${dateLabel(appointment.date)} at ${timeLabel(appointment.startTime)}`;
    const status = appointment.status.toLowerCase().replace('_', ' ');
    if (kind === 'BOOK') {
      if (appointment.status === 'PENDING') return `Your slot with ${where} is held. Pay ${rupees(appointment.doctor.consultationFee * 100)} to confirm it: it is not booked until the payment is verified.`;
      return appointment.status === 'CONFIRMED' ? `Booked: ${where}.` : `The booking with ${where} was made, but it is now ${status}.`;
    }
    if (kind === 'RESCHEDULE') {
      return appointment.status === 'CONFIRMED' ? `Moved: ${where}. Your old time was released.` : `The appointment was moved to ${where}, but it is now ${status}.`;
    }
    return `Cancelled: ${where}. ${this.refundOutcome(appointment)}`;
  }

  private async appointmentFor(user: AuthUser, id: string): Promise<PatientAppointmentRow> {
    const found = (await this.appointments.listForPatient(user)).find((row) => row.id === id);
    if (!found) throw new NotFoundException('Appointment not found.');
    return found;
  }

  /** Records an ending. If this write fails the action stays CONFIRMING and is settled later from the records: it must never mask the real outcome. */
  private async settle(ref: string, status: 'FAILED', failure: string): Promise<void> {
    try {
      await this.actions.update({ id: ref, status: 'CONFIRMING' }, { status, failure });
    } catch (error) {
      this.logger.warn(`Could not record the ending of assistant action ${ref} (${error instanceof Error ? error.name : 'error'}).`);
    }
  }

  /**
   * The one atomic step that makes a confirmation single-use: PREPARED becomes CONFIRMING (or DISMISSED) in a single UPDATE that also
   * checks the owner and the expiry against the database clock. Exactly one caller can win it; everyone else gets zero rows.
   */
  private async close(user: AuthUser, ref: string, to: 'CONFIRMING' | 'DISMISSED'): Promise<boolean> {
    const result = await this.actions
      .createQueryBuilder()
      .update(AssistantAction)
      .set({ status: to, decidedAt: () => 'now()' })
      .where("id = :ref AND user_id = :userId AND status = 'PREPARED' AND expires_at > now()", { ref, userId: user.id })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  private async issue(user: AuthUser, kind: AssistantActionKind, params: Record<string, string>, card: Omit<ActionCard, 'ref' | 'kind' | 'expiresAt'>): Promise<Prepared> {
    const expiresAt = new Date(Date.now() + this.config.assistant.confirmationMinutes * 60_000);
    const row = await this.actions.save(this.actions.create({ userId: user.id, kind, params, expiresAt }));
    const finished: ActionCard = { ref: row.id, kind, ...card, expiresAt: expiresAt.toISOString() };
    return {
      card: finished,
      forModel: {
        prepared: true,
        kind,
        details: card.lines.map((line) => `${line.label}: ${line.value}`),
        ...(card.note ? { note: card.note } : {}),
        expiresInMinutes: this.config.assistant.confirmationMinutes,
        instruction: MODEL_INSTRUCTION,
      },
    };
  }

  /**
   * The slot, if it is open right now. This is a courtesy check so the card is honest: confirming checks again, under the doctor lock.
   * `ignoreAppointmentId` is the appointment being moved: the move releases its old time before taking the new one, so a target that
   * looks full only because of that appointment (an overlapping slot, or a session at its cap) is open for the move.
   */
  private async openSlot(doctorId: string, date: string, startTime: string, doctorName: string, ignoreAppointmentId?: string) {
    const day = ignoreAppointmentId
      ? await loadDaySchedule(this.dataSource.manager, doctorId, date, { timeZone: this.config.clinicTimezone, bookingWindowDays: this.config.bookingWindowDays, ignoreAppointmentId })
      : await this.doctors.slots(doctorId, date, true);
    const slot = day.slots.find((candidate) => candidate.startTime === startTime && candidate.status === 'AVAILABLE');
    if (!slot) {
      throw new ConflictException(day.unavailableReason ? `${doctorName} is not available on that date (${day.unavailableReason}).` : 'That time is not open right now. Look up the open times and choose one of them.');
    }
    return slot;
  }

  /** The patient's own appointment, found through the existing list (so it can only ever be theirs), or "not found". */
  private async ownAppointment(user: AuthUser, id: string) {
    return this.appointmentFor(user, id);
  }

  private assertChangeable(appointment: { status: string; date: string; startTime: string }): void {
    const blocked = changeBlockedReason({ status: appointment.status, date: appointment.date, startTime: appointment.startTime }, clinicNow(this.config.clinicTimezone));
    if (blocked) throw new ConflictException(blocked);
  }

  /** What the clinic's refund policy would give back if the patient cancelled right now. An estimate: confirming decides it for real. */
  private refundText(appointment: PatientAppointmentRow): string {
    if (appointment.status === 'PENDING') return 'Not paid yet, so nothing to refund. Cancelling releases the held slot.';
    const payment = appointment.payment;
    if (!payment || payment.status !== 'PAID') return 'No payment was taken, so nothing to refund.';
    const decision = refundFor({
      paidPaise: payment.amountPaise,
      appointmentStart: zonedInstant(appointment.date, appointment.startTime, this.config.clinicTimezone),
      now: new Date(),
      cancelledBy: 'PATIENT',
      policy: this.config.payments.refundPolicy,
    });
    return decision.amountPaise > 0 ? `About ${rupees(decision.amountPaise)} of the ${rupees(payment.amountPaise)} paid (${decision.percent}%). ${decision.reason}` : decision.reason;
  }

  /** What actually happened to the money after a cancellation, from the real payment record. A refund counts as done only once confirmed. */
  private refundOutcome(appointment: { payment: { displayStatus: string; amountPaise: number; refunds: { amountPaise: number; status: string }[] } | null }): string {
    const payment = appointment.payment;
    if (!payment || payment.displayStatus === 'EXPIRED' || payment.displayStatus === 'PAYMENT_PENDING' || payment.displayStatus === 'PAYMENT_FAILED') return 'Nothing had been paid, so there is nothing to refund.';
    const refund = payment.refunds[0];
    if (!refund) return payment.displayStatus === 'PAID' ? 'No refund applies under the clinic policy.' : '';
    const amount = rupees(refund.amountPaise);
    if (refund.status === 'PROCESSED') return `A refund of ${amount} has been processed.`;
    if (refund.status === 'FAILED') return `A refund of ${amount} could not be completed yet; the clinic will follow up.`;
    return `A refund of ${amount} has been started and is pending: it is complete only once the payment provider confirms it.`;
  }

  /**
   * Why a reference could not be used, in words that do not reveal whether it belongs to someone else: another user's reference is simply
   * "not found". A reference that was confirmed but never finished is reconciled first, so the answer says what actually happened.
   */
  private async whyNotClaimable(user: AuthUser, ref: string): Promise<HttpException> {
    const row = await this.actions.findOneBy({ id: ref, userId: user.id });
    if (!row) return new NotFoundException('That confirmation was not found.');
    if (row.status === 'PREPARED') return new HttpException(EXPIRED, HttpStatus.GONE); // still open but past its time
    if (row.status === 'CONFIRMING') {
      const found = await this.reconcile(row).catch(() => null);
      const detail =
        found?.state === 'DONE'
          ? { code: 'ACTION_ALREADY_DONE', message: 'This confirmation was already carried out, so nothing more was done. Check its status for the details.' }
          : found?.state === 'NOT_APPLIED'
            ? { code: 'ACTION_NOT_APPLIED', message: `${found.why} Nothing was repeated. Ask me again if you still want it.` }
            : found?.state === 'UNCERTAIN'
              ? { code: 'ACTION_UNCERTAIN', message: `${found.why} Nothing was repeated. Open My Appointments to see what really happened.` }
              : { code: 'ACTION_IN_PROGRESS', message: 'This confirmation is still being processed. Nothing was repeated. Check its status in a moment.' };
      return new ConflictException({ statusCode: 409, error: 'Conflict', ...detail });
    }
    return new ConflictException(USED);
  }
}
