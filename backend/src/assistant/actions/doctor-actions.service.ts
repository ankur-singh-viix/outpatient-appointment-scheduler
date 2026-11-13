import { BadRequestException, ConflictException, ForbiddenException, GoneException, HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppointmentsService } from '../../appointments/appointments.service.js';
import type { AuthUser } from '../../auth/auth.types.js';
import { loadConfig } from '../../config.js';
import { Appointment, Availability, Doctor, ScheduleOverride, slotIntervalOf } from '../../database/entities/index.js';
import { AvailabilityChangeService, pendingRule } from '../../doctor-portal/availability-change.service.js';
import { DoctorPortalService } from '../../doctor-portal/doctor-portal.service.js';
import { DoctorsService } from '../../doctors/doctors.service.js';
import { changeBlockedReason } from '../../scheduling/appointment-rules.js';
import { clinicNow } from '../../scheduling/calendar.js';
import { toRule } from '../../scheduling/day-schedule.js';
import { slotsOn } from '../../scheduling/elastic.js';
import { toOverride } from '../../scheduling/outside-hours.js';
import { hhmm, toMinutes } from '../../scheduling/slots.js';
import { dateLabel, rangeLabel, timeLabel, type ActionCard, type DoctorCardKind } from './action-cards.js';
import { TokenSigner } from './signed-token.js';

/** The database stamps a change with its own clock, the token with this server's: allow for the two to differ a little. */
const CLOCK_SKEW_MS = 300_000;
/** How many appointments a card lists by name (the count always covers all of them). */
const CARD_PATIENTS = 8;
/** The most appointments the assistant will cancel in one go when blocking a day. More than this is done from the Appointments page. */
export const CANCEL_ALL_LIMIT = 10;

type Kind = Exclude<DoctorCardKind, 'SCHEDULE_CHANGE'>;
type Handling = 'KEEP' | 'CANCEL';

/** What a signed confirmation carries: everything the confirmation will do. The signature stops anyone editing it. */
interface Payload {
  v: 1;
  t: Kind;
  /** The doctor's user it was made for. */
  u: string;
  /** A one-off id, so a token already used in this process is recognised. */
  j: string;
  /** Issued at, expires at (ms since 1970). */
  i: number;
  x: number;
  /** Cancel / reschedule: the appointment, and the patient's name for messages. */
  a?: string;
  pn?: string;
  /** The date (and time) as previewed: the appointment's own, the new session's, or the day being blocked. */
  d?: string;
  s?: string;
  e?: string;
  /** Reschedule: the new date and time. */
  nd?: string;
  ns?: string;
  /** Cancel: the reason the patient is told. Block day: the reason on the exception. */
  r?: string;
  /** Add hours: patients per slot. */
  m?: number;
  /** Block day: how the booked appointments are handled, how many there were, and a fingerprint of exactly which. */
  h?: Handling;
  n?: number;
  k?: string;
}

export type DoctorPrepareOutcome =
  | { prepared: true; card: ActionCard; summary: Record<string, unknown> }
  | { prepared: false; problems: string[] }
  /** Blocking a day with booked appointments: the doctor must say how to handle them before anything is shown for confirmation. */
  | { prepared: false; needsDecision: true; appointments: number; options: { handling: string; meaning: string }[] };

export interface DoctorActionResult {
  kind: DoctorCardKind;
  outcome: 'DONE';
  message: string;
  alreadyApplied: boolean;
}

interface AppointmentRef {
  id: string;
  patientId: string;
  date: string;
  startTime: string;
  endTime: string;
  patientName: string;
}

/**
 * Four doctor actions the assistant can PREPARE (cancel an appointment, move an appointment, add working hours, block a day). Like
 * the schedule-change card, each is a read-only preview that produces a card with a signed, expiring token, and only the doctor's own
 * button press (a separate request the model cannot make) runs it. Every action then goes through the service the app already uses for
 * it (DoctorPortalService for cancel, hours and day blocks; AppointmentsService for moving), so ownership, status, slot conflicts, the
 * minimum-notice rule, locking, refunds and patient notices are the existing ones, checked again at that moment.
 *
 * No table is involved. A token is bound to the exact thing previewed (the appointment and its time, the target slot, the hours, the
 * day and the exact appointments on it), so anything that changed since is refused as stale. A repeat is recognised either from this
 * process's memory of tokens already used or, failing that, from the records (the appointment is already cancelled / moved, the
 * session already exists, the day already blocked), and is answered as "already done", never run again.
 */
@Injectable()
export class DoctorActionsService {
  private readonly logger = new Logger(DoctorActionsService.name);
  private readonly config = loadConfig();
  private readonly signer = new TokenSigner(this.config.jwtSecret, 'assistant-doctor-action-v1');
  /** Tokens used or running in this process (until they expire). The records settle the same question when this is empty (another server, a restart). */
  private readonly done = new Map<string, number>();
  private readonly running = new Map<string, Promise<DoctorActionResult>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly portal: DoctorPortalService,
    private readonly changes: AvailabilityChangeService,
    private readonly appointments: AppointmentsService,
    private readonly doctors: DoctorsService,
  ) {}

  // ---- preparing: read-only ----

  async prepareCancel(user: AuthUser, input: { date: string; startTime?: string; patientName?: string; reason: string }): Promise<DoctorPrepareOutcome> {
    const found = await this.findAppointment(user, input);
    if ('problems' in found) return { prepared: false, problems: found.problems };
    const a = found.appointment;
    const payload = this.base('DOCTOR_CANCEL', user, { a: a.id, pn: a.patientName, d: a.date, s: a.startTime, e: a.endTime, r: input.reason });
    const card = this.card(payload, {
      kind: 'DOCTOR_CANCEL',
      title: 'Cancel this appointment?',
      lines: [
        { label: 'Patient', value: a.patientName },
        { label: 'Appointment', value: `${dateLabel(a.date)}, ${rangeLabel(a.startTime, a.endTime)}` },
        { label: 'Reason the patient is told', value: input.reason },
        { label: 'Payment', value: 'If the patient has paid, they are refunded in full' },
        { label: 'Patient notice', value: 'They are emailed about the cancellation' },
      ],
      note: 'This cancels the booking. It cannot be undone from here.',
      confirmLabel: 'Cancel appointment',
      dismissLabel: 'Keep it',
    });
    return { prepared: true, card, summary: { kind: 'CANCEL_APPOINTMENT', date: a.date, startTime: a.startTime, patientNotified: true, refundedInFullIfPaid: true } };
  }

  async prepareReschedule(user: AuthUser, input: { date: string; startTime?: string; patientName?: string; newDate: string; newStartTime: string }): Promise<DoctorPrepareOutcome> {
    const found = await this.findAppointment(user, input);
    if ('problems' in found) return { prepared: false, problems: found.problems };
    const a = found.appointment;
    if (input.newDate === a.date && input.newStartTime === a.startTime) return { prepared: false, problems: ['The appointment is already at that time.'] };
    if (found.status === 'PENDING') return { prepared: false, problems: ['This booking is still waiting for the patient to pay, so it cannot be moved. Cancel it or wait for the payment.'] };

    // The same slot engine that books patients: the target must be a real, open slot right now.
    const target = await this.openSlot(found.doctorId, input.newDate, input.newStartTime);
    if (!target.slot) return { prepared: false, problems: [target.why] };
    const payload = this.base('DOCTOR_RESCHEDULE', user, { a: a.id, pn: a.patientName, d: a.date, s: a.startTime, e: a.endTime, nd: input.newDate, ns: input.newStartTime });
    const card = this.card(payload, {
      kind: 'DOCTOR_RESCHEDULE',
      title: 'Move this appointment?',
      lines: [
        { label: 'Patient', value: a.patientName },
        { label: 'From', value: `${dateLabel(a.date)}, ${rangeLabel(a.startTime, a.endTime)}` },
        { label: 'To', value: `${dateLabel(input.newDate)}, ${rangeLabel(target.slot.startTime, target.slot.endTime)}` },
        { label: 'Patient notice', value: 'They are emailed the old and the new time' },
        { label: 'Payment', value: 'Carries over to the new time' },
      ],
      note: 'The patient did not ask for this move. Only continue if you have agreed it with them or need to.',
      confirmLabel: 'Move appointment',
      dismissLabel: 'Keep the current time',
    });
    return { prepared: true, card, summary: { kind: 'RESCHEDULE_APPOINTMENT', from: { date: a.date, startTime: a.startTime }, to: { date: input.newDate, startTime: target.slot.startTime }, patientNotified: true } };
  }

  async prepareAddHours(user: AuthUser, input: { date: string; startTime: string; endTime: string; patientsPerSlot?: number }): Promise<DoctorPrepareOutcome> {
    const doctor = await this.doctorOf(user);
    const clock = clinicNow(this.config.clinicTimezone);
    if (input.date < clock.date) return { prepared: false, problems: ['You can only add hours for today or a future date.'] };
    if (toMinutes(input.endTime) <= toMinutes(input.startTime)) return { prepared: false, problems: ['The end time must be after the start time.'] };
    const perSlot = input.patientsPerSlot ?? 1;
    const manager = this.dataSource.manager;

    const sameDay = await manager.find(Availability, { where: { doctorId: doctor.id, recurrenceType: 'ONE_TIME', specificDate: input.date } });
    const clash = sameDay.find((row) => toMinutes(input.startTime) < toMinutes(row.endTime) && toMinutes(row.startTime) < toMinutes(input.endTime));
    if (clash) {
      return {
        prepared: false,
        problems: [`That overlaps a session already added for ${input.date} (${hhmm(clash.startTime)}-${hhmm(clash.endTime)}). To make an existing session longer, change its hours instead of adding a new one.`],
      };
    }
    const row = {
      recurrenceType: 'ONE_TIME' as const,
      dayOfWeek: null,
      specificDate: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      capacity: null,
      schedulingMode: perSlot > 1 ? ('WAVE' as const) : ('STREAM' as const),
      slotDurationMinutes: doctor.consultationMinutes,
      capacityPerSlot: perSlot,
      effectiveFrom: null,
      effectiveTo: null,
    };
    if (toMinutes(input.endTime) - toMinutes(input.startTime) < doctor.consultationMinutes) {
      return { prepared: false, problems: [`The hours must be at least ${doctor.consultationMinutes} minutes long, the length of one appointment.`] };
    }
    // How many bookable slots the day gains, from the same slot engine; none means something (such as a day off) is already covering the date.
    const rules = (await manager.findBy(Availability, { doctorId: doctor.id })).map(toRule);
    const exception = await manager.findOneBy(ScheduleOverride, { doctorId: doctor.id, overrideDate: input.date });
    const elastic = { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity, slotIntervalMinutes: slotIntervalOf(doctor) };
    const before = slotsOn(input.date, rules, exception ? toOverride(exception) : null, elastic).slots.length;
    const after = slotsOn(input.date, [...rules, pendingRule(row, 'pending-assistant')], exception ? toOverride(exception) : null, elastic).slots.length;
    if (after <= before) {
      return { prepared: false, problems: ['Those hours would add no bookable slots. The date may be marked as a day off or have different hours set as an exception; change that first.'] };
    }
    try {
      await this.changes.assertAdditionAllowed(manager, doctor, (current) => [...current, pendingRule(row, 'pending-assistant')]);
    } catch (error) {
      if (error instanceof HttpException) return { prepared: false, problems: [messageOf(error)] };
      throw error;
    }

    const payload = this.base('ADD_HOURS', user, { d: input.date, s: input.startTime, e: input.endTime, m: perSlot });
    const card = this.card(payload, {
      kind: 'ADD_HOURS',
      title: 'Add working hours?',
      lines: [
        { label: 'Date', value: dateLabel(input.date) },
        { label: 'Hours', value: rangeLabel(input.startTime, input.endTime) },
        { label: 'New slots', value: `${after - before} (${doctor.consultationMinutes} minutes each${perSlot > 1 ? `, ${perSlot} patients per slot` : ''})` },
        { label: 'Existing appointments', value: 'Not changed' },
      ],
      note: 'Patients can book the new slots straight away. Anyone who was waiting for a new time and fits these hours is released.',
      confirmLabel: 'Add hours',
      dismissLabel: 'Cancel',
    });
    return { prepared: true, card, summary: { kind: 'ADD_WORKING_HOURS', date: input.date, startTime: input.startTime, endTime: input.endTime, newSlots: after - before } };
  }

  async prepareBlockDay(user: AuthUser, input: { date: string; handling?: Handling; cancelReason?: string; reason?: string }): Promise<DoctorPrepareOutcome> {
    const doctor = await this.doctorOf(user);
    const clock = clinicNow(this.config.clinicTimezone);
    if (input.date < clock.date) return { prepared: false, problems: ['You can only block today or a future date.'] };
    const day = await this.doctors.slots(doctor.id, input.date, false);
    const exception = await this.dataSource.getRepository(ScheduleOverride).findOneBy({ doctorId: doctor.id, overrideDate: input.date });
    if (exception && !exception.isAvailable && !exception.startTime) return { prepared: false, problems: ['That day is already blocked.'] };
    if (day.sessions.length === 0 && !exception) return { prepared: false, problems: ['There are no working hours on that date, so there is nothing to block.'] };

    const affected = await this.activeOn(user, input.date);
    if (affected.length > 0 && !input.handling) {
      return {
        prepared: false,
        needsDecision: true,
        appointments: affected.length,
        options: [
          { handling: 'KEEP_AND_ASK_PATIENTS', meaning: 'The appointments stay booked and each patient is emailed asking them to choose a new time. Nobody is cancelled or refunded.' },
          {
            handling: 'CANCEL_AND_REFUND',
            meaning: `Every appointment on that day is cancelled with a reason, each patient is emailed, and anyone who paid is refunded in full.${affected.length > CANCEL_ALL_LIMIT ? ` (Not available here: more than ${CANCEL_ALL_LIMIT} appointments; cancel them from the Appointments page.)` : ''}`,
          },
        ],
      };
    }
    if (input.handling === 'CANCEL' && affected.length > CANCEL_ALL_LIMIT) {
      return { prepared: false, problems: [`That is ${affected.length} appointments, more than the ${CANCEL_ALL_LIMIT} the assistant will cancel in one go. Keep them and ask the patients to choose a new time, or cancel them from the Appointments page first.`] };
    }
    const handling = affected.length === 0 ? undefined : input.handling;
    const cancelReason = handling === 'CANCEL' ? (input.cancelReason?.trim() || 'The doctor is not available on this date') : undefined;
    if (cancelReason && cancelReason.length < 3) return { prepared: false, problems: ['Give a reason of at least 3 characters for the cancellations.'] };

    const names = new Map<string, number>();
    const patients = affected.slice(0, CARD_PATIENTS).map((entry) => {
      const base = `${timeLabel(entry.startTime)}`;
      const seen = (names.get(base) ?? 0) + 1;
      names.set(base, seen);
      return { label: seen > 1 ? `${base} (${seen})` : base, value: entry.patientName };
    });
    const lines: ActionCard['lines'] = [
      { label: 'Date', value: `${dateLabel(input.date)}, the whole day` },
      { label: 'Effect', value: 'Patients can no longer book that day' },
    ];
    if (exception) lines.push({ label: 'Replaces', value: exception.isAvailable ? 'The different hours already set for that day' : 'The blocked time already set for that day' });
    if (affected.length === 0) lines.push({ label: 'Booked appointments', value: 'None' });
    else {
      lines.push({
        label: 'Booked appointments',
        value: handling === 'CANCEL' ? `${affected.length}: all will be CANCELLED, with a refund in full if paid` : `${affected.length}: they stay booked and each patient is emailed to choose a new time`,
      });
      if (cancelReason) lines.push({ label: 'Reason the patients are told', value: cancelReason });
      lines.push(...patients);
      if (affected.length > patients.length) lines.push({ label: 'And', value: `${affected.length - patients.length} more` });
    }
    const payload = this.base('BLOCK_DAY', user, { d: input.date, h: handling, n: affected.length, k: fingerprint(affected.map((entry) => entry.id)), r: handling === 'CANCEL' ? cancelReason : input.reason?.trim() || undefined });
    const card = this.card(payload, {
      kind: 'BLOCK_DAY',
      title: 'Block this day?',
      lines,
      note: handling === 'CANCEL' ? 'The appointments are cancelled first, then the day is blocked.' : 'Nothing is cancelled or moved. Emails go out after you confirm.',
      confirmLabel: handling === 'CANCEL' ? `Cancel ${affected.length} and block the day` : affected.length > 0 ? `Block the day and notify ${affected.length}` : 'Block the day',
      dismissLabel: 'Cancel',
    });
    return { prepared: true, card, summary: { kind: 'BLOCK_DAY', date: input.date, bookedAppointments: affected.length, handling: handling === 'CANCEL' ? 'CANCEL_AND_REFUND' : handling === 'KEEP' ? 'KEEP_AND_ASK_PATIENTS' : 'NONE_BOOKED' } };
  }

  // ---- confirming: the doctor pressed the button ----

  async confirm(user: AuthUser, token: string): Promise<DoctorActionResult> {
    const payload = this.read(token);
    if (payload.u !== user.id) throw new ForbiddenException('This confirmation was not made for you.');
    if (Date.now() >= payload.x) throw new GoneException('This confirmation has expired.');
    for (const [id, expires] of this.done) if (expires < Date.now()) this.done.delete(id);

    const running = this.running.get(payload.j);
    if (running) return running.then((result) => ({ ...result, alreadyApplied: true })); // a double click: the second waits for the first
    if (this.done.has(payload.j)) return this.already(payload);

    const work = this.run(user, payload)
      .then((result) => {
        this.done.set(payload.j, payload.x);
        return result;
      })
      .finally(() => this.running.delete(payload.j));
    this.running.set(payload.j, work);
    return work;
  }

  private async run(user: AuthUser, p: Payload): Promise<DoctorActionResult> {
    switch (p.t) {
      case 'DOCTOR_CANCEL':
        return this.runCancel(user, p);
      case 'DOCTOR_RESCHEDULE':
        return this.runReschedule(user, p);
      case 'ADD_HOURS':
        return this.runAddHours(user, p);
      case 'BLOCK_DAY':
        return this.runBlockDay(user, p);
    }
  }

  private async runCancel(user: AuthUser, p: Payload): Promise<DoctorActionResult> {
    const doctor = await this.doctorOf(user);
    const row = await this.dataSource.getRepository(Appointment).findOneBy({ id: p.a, doctorId: doctor.id });
    if (!row) throw stale('The appointment is no longer there.');
    if (this.cancelledByMe(row, user, p)) return this.already(p);
    if (row.appointmentDate !== p.d || hhmm(row.startTime) !== p.s) throw stale('The appointment was changed.');
    try {
      await this.portal.cancelAppointment(user, p.a as string, p.r as string);
    } catch (error) {
      if (error instanceof ConflictException && (await this.isCancelledByMe(p.a as string, user, p))) return this.already(p);
      throw error;
    }
    return { kind: 'DOCTOR_CANCEL', outcome: 'DONE', alreadyApplied: false, message: `Cancelled ${p.pn}'s appointment on ${dateLabel(p.d as string)} at ${timeLabel(p.s as string)}. The patient has been emailed, and any payment is refunded in full.` };
  }

  private async runReschedule(user: AuthUser, p: Payload): Promise<DoctorActionResult> {
    const doctor = await this.doctorOf(user);
    const repo = this.dataSource.getRepository(Appointment);
    const row = await repo.findOneBy({ id: p.a, doctorId: doctor.id });
    if (!row) throw stale('The appointment is no longer there.');
    if (await this.movedByMe(p)) return this.already(p);
    if (row.status !== 'CONFIRMED' || row.appointmentDate !== p.d || hhmm(row.startTime) !== p.s) throw stale('The appointment was changed.');
    const target = await this.openSlot(doctor.id, p.nd as string, p.ns as string);
    if (!target.slot) throw stale(target.why);
    try {
      await this.appointments.rescheduleFor(user, row.id, row.patientId, { date: p.nd as string, startTime: p.ns as string });
    } catch (error) {
      if (error instanceof HttpException && (await this.movedByMe(p))) return this.already(p);
      throw error;
    }
    return { kind: 'DOCTOR_RESCHEDULE', outcome: 'DONE', alreadyApplied: false, message: `Moved ${p.pn}'s appointment to ${dateLabel(p.nd as string)} at ${timeLabel(p.ns as string)}. The patient has been emailed the new time.` };
  }

  private async runAddHours(user: AuthUser, p: Payload): Promise<DoctorActionResult> {
    const doctor = await this.doctorOf(user);
    const exists = async () =>
      (await this.dataSource.getRepository(Availability).findBy({ doctorId: doctor.id, recurrenceType: 'ONE_TIME', specificDate: p.d as string })).some((row) => hhmm(row.startTime) === p.s && hhmm(row.endTime) === p.e);
    if (await exists()) return this.already(p);
    let restored = 0;
    try {
      const result = await this.portal.addOneTime(user, {
        date: p.d as string,
        startTime: p.s as string,
        endTime: p.e as string,
        schedulingMode: (p.m ?? 1) > 1 ? 'WAVE' : 'STREAM',
        capacityPerSlot: p.m ?? 1,
      });
      restored = result.restoredAppointments;
    } catch (error) {
      if (error instanceof HttpException && (await exists())) return this.already(p);
      throw error;
    }
    return {
      kind: 'ADD_HOURS',
      outcome: 'DONE',
      alreadyApplied: false,
      message: `Added ${rangeLabel(p.s as string, p.e as string)} on ${dateLabel(p.d as string)}. Patients can book it now.${restored > 0 ? ` ${restored} waiting appointment${restored === 1 ? ' is' : 's are'} valid again.` : ''}`,
    };
  }

  private async runBlockDay(user: AuthUser, p: Payload): Promise<DoctorActionResult> {
    const doctor = await this.doctorOf(user);
    const date = p.d as string;
    const exception = await this.dataSource.getRepository(ScheduleOverride).findOneBy({ doctorId: doctor.id, overrideDate: date });
    if (exception && !exception.isAvailable && !exception.startTime) return this.already(p);

    const affected = await this.activeOn(user, date);
    if (affected.length !== (p.n ?? 0) || fingerprint(affected.map((entry) => entry.id)) !== p.k) {
      throw stale(`The appointments on that day are not the same as when this was prepared (${affected.length} now, ${p.n} then).`);
    }
    let cancelled = 0;
    if (p.h === 'CANCEL') {
      const failed: string[] = [];
      for (const entry of affected) {
        try {
          await this.portal.cancelAppointment(user, entry.id, p.r as string);
          cancelled++;
        } catch (error) {
          if (!(error instanceof HttpException)) this.logger.error(`Cancelling an appointment while blocking a day failed (${error instanceof Error ? error.name : 'error'}).`);
          failed.push(`${timeLabel(entry.startTime)} ${entry.patientName}`);
        }
      }
      if (failed.length > 0) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'BLOCK_DAY_PARTIAL',
          message: `Cancelled ${cancelled} of ${affected.length} appointments. These could not be cancelled: ${failed.join(', ')}. The day was NOT blocked. Check the Appointments page, then ask me again.`,
        });
      }
    }
    try {
      const result = await this.portal.upsertOverride(user, { date, isAvailable: false, reason: p.h === 'CANCEL' ? undefined : p.r }, p.h === 'KEEP');
      const asked = (result as { patientsAsked?: number }).patientsAsked ?? 0;
      const parts = [`${dateLabel(date)} is now blocked.`];
      if (cancelled > 0) parts.push(`${cancelled} appointment${cancelled === 1 ? ' was' : 's were'} cancelled; each patient has been emailed and anyone who paid is refunded in full.`);
      else if (asked > 0) parts.push(`${asked} booked appointment${asked === 1 ? ' stays' : 's stay'} booked, and ${asked === 1 ? 'that patient is' : 'those patients are'} being emailed to choose a new time. Ask me to check scheduling conflicts to see who has been reached.`);
      return { kind: 'BLOCK_DAY', outcome: 'DONE', alreadyApplied: false, message: parts.join(' ') };
    } catch (error) {
      const again = await this.dataSource.getRepository(ScheduleOverride).findOneBy({ doctorId: doctor.id, overrideDate: date });
      if (again && !again.isAvailable && !again.startTime && cancelled === 0) return this.already(p);
      if (cancelled > 0 && error instanceof HttpException) {
        throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'BLOCK_DAY_PARTIAL', message: `${cancelled} appointment${cancelled === 1 ? ' was' : 's were'} cancelled, but the day could not be blocked: ${messageOf(error)} Ask me to block it again.` });
      }
      throw error;
    }
  }

  // ---- shared pieces ----

  private base(t: Kind, user: AuthUser, fields: Partial<Payload>): Payload {
    const now = Date.now();
    return { v: 1, t, u: user.id, j: randomUUID(), i: now, x: now + this.config.assistant.confirmationMinutes * 60_000, ...fields };
  }

  private card(payload: Payload, parts: Omit<ActionCard, 'ref' | 'expiresAt'>): ActionCard {
    return { ref: this.signer.sign(payload), expiresAt: new Date(payload.x).toISOString(), ...parts };
  }

  private read(token: string): Payload {
    const p = this.signer.verify(token) as Partial<Payload>;
    const kinds: Kind[] = ['DOCTOR_CANCEL', 'DOCTOR_RESCHEDULE', 'ADD_HOURS', 'BLOCK_DAY'];
    if (p.v !== 1 || !p.t || !kinds.includes(p.t) || typeof p.u !== 'string' || typeof p.j !== 'string' || typeof p.i !== 'number' || typeof p.x !== 'number') {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'INVALID_CONFIRMATION', message: 'This confirmation is not valid.' });
    }
    return p as Payload;
  }

  private already(p: Payload): DoctorActionResult {
    return { kind: p.t, outcome: 'DONE', alreadyApplied: true, message: 'This was already done, so nothing was repeated.' };
  }

  private async doctorOf(user: AuthUser): Promise<Doctor> {
    const doctor = await this.dataSource.getRepository(Doctor).findOneBy({ userId: user.id });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return doctor;
  }

  /** The doctor's active appointments on a date that have not started, as the doctor portal lists them. */
  private async activeOn(user: AuthUser, date: string) {
    const clock = clinicNow(this.config.clinicTimezone);
    const rows = await this.portal.appointments(user, 'all', date);
    return rows
      .filter((row) => changeBlockedReason({ status: row.status, date: row.date, startTime: row.startTime }, clock) === null)
      .map((row) => ({ id: row.id, startTime: row.startTime, endTime: row.endTime, patientName: row.patient.name, status: row.status }));
  }

  /** Finds the one active appointment of this doctor that the request describes, or says what is missing or ambiguous. */
  private async findAppointment(
    user: AuthUser,
    input: { date: string; startTime?: string; patientName?: string },
  ): Promise<{ appointment: AppointmentRef; status: string; doctorId: string } | { problems: string[] }> {
    const doctor = await this.doctorOf(user);
    const rows = (await this.activeOn(user, input.date)).filter(
      (row) => (!input.startTime || row.startTime === input.startTime) && (!input.patientName || row.patientName.toLowerCase().includes(input.patientName.trim().toLowerCase())),
    );
    if (rows.length === 0) return { problems: [`No active appointment that has not started matches that on ${input.date}. Check the date, time and name with get_appointments_on_date.`] };
    if (rows.length > 1) return { problems: [`More than one appointment matches (${rows.map((row) => `${timeLabel(row.startTime)} ${row.patientName}`).join('; ')}). Ask the doctor which one, then give the time and the patient's name.`] };
    const row = rows[0];
    const patientId = (await this.dataSource.getRepository(Appointment).findOneByOrFail({ id: row.id, doctorId: doctor.id })).patientId;
    return { appointment: { id: row.id, patientId, date: input.date, startTime: row.startTime, endTime: row.endTime, patientName: row.patientName }, status: row.status, doctorId: doctor.id };
  }

  /** The slot at that time if patients could book it right now; otherwise why not, with the open times that day. */
  private async openSlot(doctorId: string, date: string, startTime: string): Promise<{ slot: { startTime: string; endTime: string } | null; why: string }> {
    const day = await this.doctors.slots(doctorId, date, false);
    const slot = day.slots.find((candidate) => candidate.startTime === startTime);
    if (slot?.status === 'AVAILABLE') return { slot: { startTime: slot.startTime, endTime: slot.endTime }, why: '' };
    const open = day.slots.filter((candidate) => candidate.status === 'AVAILABLE').slice(0, 6).map((candidate) => timeLabel(candidate.startTime));
    const why = !slot ? `There is no slot at ${timeLabel(startTime)} on ${date}.` : `The ${timeLabel(startTime)} slot on ${date} is not open (${slot.status.toLowerCase()}).`;
    return { slot: null, why: `${why} ${open.length > 0 ? `Open times that day: ${open.join(', ')}.` : 'Nothing is open that day.'}` };
  }

  private cancelledByMe(row: Appointment, user: AuthUser, p: Payload): boolean {
    return row.status === 'CANCELLED' && row.cancelledByUserId === user.id && row.cancelledAt !== null && row.cancelledAt.getTime() >= p.i - CLOCK_SKEW_MS;
  }

  private async isCancelledByMe(id: string, user: AuthUser, p: Payload): Promise<boolean> {
    const row = await this.dataSource.getRepository(Appointment).findOneBy({ id });
    return row !== null && this.cancelledByMe(row, user, p);
  }

  /** True when a newer appointment already follows this one at the requested time (the move happened). */
  private async movedByMe(p: Payload): Promise<boolean> {
    const next = await this.dataSource.getRepository(Appointment).findBy({ rescheduledFromId: p.a, appointmentDate: p.nd });
    return next.some((row) => hhmm(row.startTime) === p.ns && row.createdAt.getTime() >= p.i - CLOCK_SKEW_MS);
  }
}

const fingerprint = (ids: string[]): string => createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 16);

const stale = (why: string) =>
  new ConflictException({ statusCode: 409, error: 'Conflict', code: 'DOCTOR_ACTION_STALE', message: `${why} Nothing was changed. Ask me to prepare it again to see the current picture.` });

function messageOf(error: HttpException): string {
  const body = error.getResponse();
  return typeof body === 'string' ? body : ((body as { message?: string | string[] }).message instanceof Array ? ((body as { message: string[] }).message.join(' ')) : ((body as { message?: string }).message ?? error.message));
}
