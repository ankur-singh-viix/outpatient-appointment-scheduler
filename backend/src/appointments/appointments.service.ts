import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { ACTIVE_STATUSES, Appointment, Availability, Doctor, Patient, ScheduleOverride, slotIntervalOf } from '../database/entities/index.js';
import { isSlotConflict } from '../database/errors.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import type { PaymentSummary } from '../payments/payment-summary.js';
import { changeBlockedReason } from '../scheduling/appointment-rules.js';
import { addDays, clinicNow, isValidDate } from '../scheduling/calendar.js';
import { bookedLoader, openTimes } from '../scheduling/open-times.js';
import { loadDaySchedule, toRule } from '../scheduling/day-schedule.js';
import { appointmentsOutsideHours, toOverride } from '../scheduling/outside-hours.js';
import { hhmm, nextFreeSeat, type Slot } from '../scheduling/slots.js';
import { isMissingColumn } from './appointment-history.service.js';
import { assertTransition } from './appointment-lifecycle.js';

export interface BookAppointmentInput {
  doctorId: string;
  date: string;
  startTime: string;
  /** Optional: the availability the patient believes the slot belongs to. Refused when the slot comes from a different one. */
  availabilityId?: string;
}

export interface RescheduleInput {
  date: string;
  startTime: string;
}

/** A cursor is "date|start", base64url. Anything else is a bad request, never a silent restart from the top. */
function parseAlternativesCursor(cursor: string): { date: string; startTime: string } {
  const [date, startTime] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!date || !isValidDate(date) || !/^\d{2}:\d{2}$/.test(startTime ?? '')) throw new BadRequestException('That page marker is not valid. Reload the list of times.');
  return { date, startTime };
}

const WITH_DOCTOR = { doctor: { user: true, specialty: true, clinic: true }, cancelledBy: true } as const;
const SLOT_TAKEN = 'That time slot has just been booked. Please choose another.';
const SLOT_FULL = 'That time slot is full: every place in it has been booked. Please choose another.';

/** The lowest free seat of the slot. There always is one for a slot that passed assertBookable; this is the backstop. */
function claimSeat(booked: Parameters<typeof nextFreeSeat>[0], slot: Slot): number {
  const seat = nextFreeSeat(booked, slot, slot.capacityPerSlot ?? 1);
  if (seat === null) throw new ConflictException((slot.capacityPerSlot ?? 1) > 1 ? SLOT_FULL : SLOT_TAKEN);
  return seat;
}

/** Throws unless the slot exists and can still be booked. Shared by booking and rescheduling. */
function assertBookable(slot: Slot | undefined): asserts slot is Slot {
  if (!slot) throw new BadRequestException('The doctor has no appointment slot at that time.');
  if (slot.status === 'PAST') throw new BadRequestException('That time slot has already passed.');
  if (slot.status === 'BOOKED') throw new ConflictException((slot.capacityPerSlot ?? 1) > 1 ? SLOT_FULL : SLOT_TAKEN);
  if (slot.status === 'FULL') {
    throw new ConflictException('This session has reached its booking capacity. Please choose another session or date.');
  }
}

@Injectable()
export class AppointmentsService {
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(Appointment) private readonly appointments: Repository<Appointment>,
    @InjectRepository(Patient) private readonly patients: Repository<Patient>,
    private readonly dataSource: DataSource,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Books a slot for the signed-in patient. Everything happens in one transaction:
   * 1. Lock the doctor's row, so concurrent bookings for this doctor run one at a time.
   * 2. Recompute the day's slots and session capacity from the database.
   * 3. Insert only if the slot exists, is in the future, still has a free seat and its session isn't full. The appointment takes
   *    the lowest free seat: a STREAM slot has one seat, a WAVE slot capacity_per_slot of them.
   * The unique index on (doctor, date, start time, seat) and the per-seat overlap constraint are the final backstops: even code
   * that skipped the lock could not put more patients in a slot than it has seats.
   */
  async book(user: AuthUser, input: BookAppointmentInput) {
    return this.bookFor(user, await this.patientIdFor(user.id), input);
  }

  /**
   * Books a slot for `patientId`, made by `user`: the patient themselves, or a receptionist acting for them (who has been checked
   * by the caller). Everything else is the same transaction, slot rules, seats and database guards as a patient's own booking.
   * `collectAtClinic` confirms the appointment at once instead of holding the slot for online payment: the fee is paid at the clinic.
   */
  async bookFor(user: AuthUser, patientId: string, input: BookAppointmentInput, options: { collectAtClinic?: boolean } = {}) {
    let appointmentId: string;
    let needsPayment = false;
    try {
      appointmentId = await this.dataSource.transaction(async (manager) => {
        // Lock the doctor first: this is what serialises bookings, and it must happen before expired holds are freed.
        const doctor = await manager.findOne(Doctor, { where: { id: input.doctorId }, lock: { mode: 'pessimistic_write' } });
        if (!doctor) throw new NotFoundException('Doctor not found.');
        await this.payments.prepareForBooking(manager, doctor.id, patientId);

        const schedule = await loadDaySchedule(manager, input.doctorId, input.date, {
          timeZone: this.config.clinicTimezone,
          bookingWindowDays: this.config.bookingWindowDays,
          lockDoctor: true,
        });

        const slot = schedule.slots.find((candidate) => candidate.startTime === input.startTime);
        assertBookable(slot);
        if (input.availabilityId !== undefined) {
          if (!(await manager.existsBy(Availability, { id: input.availabilityId, doctorId: input.doctorId }))) {
            throw new NotFoundException('Availability not found for this doctor.');
          }
          if (slot.availabilityId !== input.availabilityId) {
            throw new BadRequestException('That time slot does not belong to the availability you chose.');
          }
        }
        const seat = claimSeat(schedule.booked, slot);
        await this.assertNoDuplicate(manager, patientId, input.doctorId, input.date, slot);

        // With payments on, a booking with a fee is a HOLD: the slot is reserved but unconfirmed until payment succeeds.
        // The fee is read from the database here, never from the request. Without payments, or for a free doctor, it is confirmed as before.
        needsPayment = !options.collectAtClinic && this.payments.enabled && doctor.consultationFee > 0;
        const saved = await manager.save(
          manager.create(Appointment, {
            patientId,
            doctorId: input.doctorId,
            bookedByUserId: user.id,
            appointmentDate: input.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            availabilityId: slot.availabilityId ?? null,
            slotCapacity: slot.capacityPerSlot ?? 1,
            slotNumber: seat,
            status: needsPayment ? 'PENDING' : 'CONFIRMED',
            holdExpiresAt: needsPayment ? new Date(Date.now() + this.payments.holdMinutes * 60_000) : null,
          }),
        );
        if (!needsPayment) await this.notifications.bookingConfirmed(manager, saved.id);
        return saved.id;
      });
    } catch (error) {
      if (isSlotConflict(error)) throw new ConflictException(SLOT_TAKEN);
      throw error;
    }

    if (!needsPayment) {
      this.notifications.kick();
      return this.findOne(appointmentId);
    }
    // Opening the Razorpay order is a network call, so it happens after the hold is safely committed. If it fails the hold is released.
    const checkout = await this.payments.createCheckout(appointmentId);
    return { ...(await this.findOne(appointmentId)), checkout };
  }

  /**
   * Cancels one of the signed-in patient's upcoming appointments. The row is locked while it is checked and
   * updated, so two cancels (or a cancel racing a reschedule) cannot both succeed. A cancelled appointment no
   * longer counts toward its slot or its session's capacity, because only PENDING/CONFIRMED rows do.
   */
  async cancel(user: AuthUser, id: string, reason?: string) {
    return this.cancelFor(user, id, await this.patientIdFor(user.id), reason);
  }

  /** Cancels `patientId`'s appointment, as `user` (the patient, or a receptionist acting for them). Same checks, refund and notice. */
  async cancelFor(user: AuthUser, id: string, patientId: string, reason?: string) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const appointment = await this.lockOwn(manager, id, patientId);
      this.assertChangeable(appointment);
      assertTransition(appointment.status, 'CANCELLED');
      appointment.status = 'CANCELLED';
      appointment.cancelReason = reason?.trim() || 'Cancelled by patient';
      appointment.cancelledAt = new Date();
      appointment.cancelledByUserId = user.id;
      appointment.holdExpiresAt = null;
      await manager.save(appointment);
      // Money and email are decided in the same transaction, so a cancelled appointment never lacks its refund or its notice.
      const money = await this.payments.onAppointmentCancelled(manager, appointment, 'PATIENT');
      await this.notifications.appointmentCancelled(manager, appointment.id, {
        cancelledBy: 'PATIENT',
        reason: appointment.cancelReason,
        refundNote: money.refundNote,
      });
      return money;
    });
    await this.payments.afterCommit(outcome);
    return this.findOne(id);
  }

  /**
   * Moves an upcoming appointment to another slot with the same doctor, in one transaction:
   * 1. Lock the doctor row (same order as booking), then the appointment row.
   * 2. Release the old slot by cancelling the old appointment (kept as history).
   * 3. Validate the new slot exactly like a new booking, against capacity that no longer counts the old one.
   * 4. Insert the new appointment, linked to the old one.
   * If any step fails the transaction rolls back and the original appointment is untouched.
   */
  async reschedule(user: AuthUser, id: string, input: RescheduleInput) {
    return this.rescheduleFor(user, id, await this.patientIdFor(user.id), input);
  }

  /** Moves `patientId`'s appointment, as `user` (the patient, or a receptionist acting for them). Same locking and checks. */
  async rescheduleFor(user: AuthUser, id: string, patientId: string, input: RescheduleInput) {
    const existing = await this.appointments.findOneBy({ id, patientId });
    if (!existing) throw new NotFoundException('Appointment not found.');

    try {
      const newId = await this.dataSource.transaction(async (manager) => {
        await manager.findOne(Doctor, { where: { id: existing.doctorId }, lock: { mode: 'pessimistic_write' } });
        // A lapsed unpaid hold on the target slot must not block the move: release it first (the doctor row is already locked).
        await this.payments.releaseLapsedHolds(manager, existing.doctorId);
        const current = await this.lockOwn(manager, id, patientId);
        this.assertChangeable(current);
        if (current.status === 'PENDING') {
          // An unpaid hold must not turn into a confirmed booking by moving it.
          throw new ConflictException('Finish paying for this booking, or cancel it, before rescheduling.');
        }

        if (current.appointmentDate === input.date && hhmm(current.startTime) === input.startTime) {
          throw new BadRequestException('You already have this appointment at that time. Choose a different slot.');
        }

        // Release the old slot first: a move inside a session that is full only because of this appointment must work.
        assertTransition(current.status, 'CANCELLED');
        current.status = 'CANCELLED';
        current.cancelReason = 'Rescheduled by patient';
        current.cancelledAt = new Date();
        current.cancelledByUserId = user.id;
        await manager.save(current);

        const schedule = await loadDaySchedule(manager, current.doctorId, input.date, {
          timeZone: this.config.clinicTimezone,
          bookingWindowDays: this.config.bookingWindowDays,
        });
        const slot = schedule.slots.find((candidate) => candidate.startTime === input.startTime);
        assertBookable(slot);
        const seat = claimSeat(schedule.booked, slot);
        await this.assertNoDuplicate(manager, patientId, current.doctorId, input.date, slot);

        const saved = await manager.save(
          manager.create(Appointment, {
            patientId,
            doctorId: current.doctorId,
            bookedByUserId: user.id,
            appointmentDate: input.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            availabilityId: slot.availabilityId ?? null,
            slotCapacity: slot.capacityPerSlot ?? 1,
            slotNumber: seat,
            status: 'CONFIRMED',
            rescheduledFromId: current.id,
          }),
        );
        // The payment follows the patient to the new time (no refund, no second charge) and the reminders move with it.
        await this.payments.moveToAppointment(manager, current.id, saved.id);
        await this.notifications.appointmentRescheduled(manager, current.id, saved.id);
        return saved.id;
      });
      this.notifications.kick();
      return this.findOne(newId);
    } catch (error) {
      if (isSlotConflict(error)) throw new ConflictException(SLOT_TAKEN);
      throw error;
    }
  }

  /** How many other times the patient is offered when choosing a new one. */
  private static readonly ALTERNATIVES = 8;

  /**
   * Other times the patient can move their own upcoming appointment to: open slots of the same doctor under the doctor's current
   * hours, with a free place, not started, searched from TODAY (so an earlier open date is never missed), nearest first, a page at a
   * time. `cursor` resumes after the last time of the previous page. Times that overlap the patient's own other appointment with this
   * doctor are left out, since moving there would be refused. Read-only; the move itself is the normal reschedule, which re-checks
   * everything under the doctor lock, so a time taken in the meantime is refused there and nothing is overbooked.
   * `needsNewTime` says the doctor's hours changed so that this appointment no longer fits them.
   */
  async alternativesFor(user: AuthUser, id: string, options: { limit?: number; cursor?: string } = {}) {
    const patientId = await this.patientIdFor(user.id);
    const manager = this.dataSource.manager;
    const appointment = await manager.findOne(Appointment, { where: { id, patientId } });
    if (!appointment) throw new NotFoundException('Appointment not found.');
    this.assertChangeable(appointment);
    if (appointment.status === 'PENDING') throw new ConflictException('Finish paying for this booking, or cancel it, before rescheduling.');
    const limit = options.limit ?? AppointmentsService.ALTERNATIVES;
    const after = options.cursor ? parseAlternativesCursor(options.cursor) : undefined;
    const doctor = await manager.findOneByOrFail(Doctor, { id: appointment.doctorId });
    const clock = clinicNow(this.config.clinicTimezone);
    const lastDate = addDays(clock.date, this.config.bookingWindowDays);
    const rules = (await manager.findBy(Availability, { doctorId: doctor.id })).map(toRule);
    const overrides = new Map((await manager.find(ScheduleOverride, { where: { doctorId: doctor.id, overrideDate: Between(clock.date, lastDate) } })).map((row) => [row.overrideDate, toOverride(row)]));
    // The patient's own other active appointments with this doctor: a time that overlaps one would be refused when confirmed.
    const own = await manager
      .createQueryBuilder(Appointment, 'a')
      .select(['a.appointmentDate', 'a.startTime', 'a.endTime'])
      .where('a.patientId = :patientId AND a.doctorId = :doctorId AND a.id <> :id', { patientId, doctorId: doctor.id, id: appointment.id })
      .andWhere('a.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .andWhere('a.appointmentDate BETWEEN :from AND :to', { from: clock.date, to: lastDate })
      .getMany();
    const busy = new Map<string, { start: string; end: string }[]>();
    for (const row of own) busy.set(row.appointmentDate, [...(busy.get(row.appointmentDate) ?? []), { start: hhmm(row.startTime), end: hhmm(row.endTime) }]);
    const found = await openTimes({
      targets: [{ id: appointment.id, date: appointment.appointmentDate, startTime: appointment.startTime, from: clock.date, after }],
      rules,
      overrides,
      elastic: { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity, slotIntervalMinutes: slotIntervalOf(doctor) },
      clock,
      lastDate,
      bookedOn: bookedLoader(manager, doctor.id, lastDate),
      limit: limit + 1, // one more than asked, to know whether there is another page
      exclude: (date, slot) => (busy.get(date) ?? []).some((window) => slot.startTime < window.end && window.start < slot.endTime),
    });
    const all = found.get(appointment.id) ?? [];
    const alternatives = all.slice(0, limit);
    const last = alternatives[alternatives.length - 1];
    const outside = await appointmentsOutsideHours(manager, doctor.id, [{ id: appointment.id, date: appointment.appointmentDate, startTime: appointment.startTime, endTime: appointment.endTime }]);
    return {
      appointmentId: appointment.id,
      doctorId: doctor.id,
      needsNewTime: outside.has(appointment.id),
      alternatives,
      /** Pass this back as `cursor` for the next page; null when there is no more in the booking window. */
      nextCursor: all.length > limit && last ? Buffer.from(`${last.date}|${last.startTime}`).toString('base64url') : null,
      searchedUntil: lastDate,
    };
  }

  async listForPatient(user: AuthUser) {
    const patientId = await this.patientIdFor(user.id);
    // Past bookings the patient removed from their own list are left out here, and only here (see hiddenIds).
    const hidden = await this.hiddenIds(patientId);
    const rows = await this.appointments.find({
      where: { patientId, ...(hidden.length > 0 ? { id: Not(In(hidden)) } : {}) },
      relations: WITH_DOCTOR,
      order: { appointmentDate: 'DESC', startTime: 'DESC' },
    });
    const payments = await this.payments.summariesFor(rows.map((row) => row.id));
    const outside = await this.outsideHours(rows);
    // `needsNewTime`: the doctor changed their hours and this booking no longer falls inside them. It is still booked.
    return rows.map((row) => ({ ...toAppointment(row, payments.get(row.id)), needsNewTime: outside.has(row.id) }));
  }

  /**
   * The patient's appointments they have removed from their own history (migration 014). A database that has not been migrated yet has
   * none, rather than failing the whole list.
   */
  private async hiddenIds(patientId: string): Promise<string[]> {
    try {
      const rows: { id: string }[] = await this.dataSource.query('SELECT id FROM appointments WHERE patient_id = $1 AND hidden_by_patient_at IS NOT NULL', [patientId]);
      return rows.map((row) => row.id);
    } catch (error) {
      if (isMissingColumn(error)) return [];
      throw error;
    }
  }

  /** The ids of the patient's upcoming active appointments that are outside their doctor's current working hours. */
  private async outsideHours(rows: Appointment[]): Promise<Set<string>> {
    const today = clinicNow(this.config.clinicTimezone).date;
    const byDoctor = new Map<string, Appointment[]>();
    for (const row of rows) {
      if (ACTIVE_STATUSES.includes(row.status) && row.appointmentDate >= today) byDoctor.set(row.doctorId, [...(byDoctor.get(row.doctorId) ?? []), row]);
    }
    const outside = new Set<string>();
    for (const [doctorId, appointments] of byDoctor) {
      const found = await appointmentsOutsideHours(this.dataSource.manager, doctorId, appointments.map((row) => ({ id: row.id, date: row.appointmentDate, startTime: row.startTime, endTime: row.endTime })));
      for (const id of found) outside.add(id);
    }
    return outside;
  }

  private async findOne(id: string) {
    const row = await this.appointments.findOneOrFail({ where: { id }, relations: WITH_DOCTOR });
    return toAppointment(row, (await this.payments.summariesFor([id])).get(id));
  }

  /**
   * One patient, one active appointment per doctor for overlapping times. A double click, a retried request or a second tab would
   * otherwise take two of a slot's places for one person. Checked inside the doctor-locked transaction, so two requests arriving
   * together are decided one after the other. (Booking for family members needs an explicit dependent-patient model, not this.)
   * Back-to-back appointments do not overlap; a cancelled one, or an unpaid hold that has run out, does not count.
   */
  private async assertNoDuplicate(manager: EntityManager, patientId: string, doctorId: string, date: string, slot: { startTime: string; endTime: string }): Promise<void> {
    const clash: unknown[] = await manager.query(
      `SELECT 1 FROM appointments
        WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3 AND status IN ('PENDING', 'CONFIRMED')
          AND NOT (status = 'PENDING' AND hold_expires_at IS NOT NULL AND hold_expires_at <= now())
          AND start_time < $5::time AND end_time > $4::time
        LIMIT 1`,
      [patientId, doctorId, date, slot.startTime, slot.endTime],
    );
    if (clash.length === 0) return;
    const [doctor] = await manager.query('SELECT u.name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = $1', [doctorId]);
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'DUPLICATE_APPOINTMENT',
      message: `You already have an appointment with ${doctor?.name ?? 'this doctor'} at that time. Choose a different time, or reschedule or cancel the one you have.`,
    });
  }

  /** Loads the patient's own appointment with a row lock. Someone else's appointment looks like a missing one. */
  private async lockOwn(manager: EntityManager, id: string, patientId: string): Promise<Appointment> {
    const appointment = await manager.findOne(Appointment, {
      where: { id, patientId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!appointment) throw new NotFoundException('Appointment not found.');
    return appointment;
  }

  private assertChangeable(appointment: Appointment): void {
    const blocked = changeBlockedReason(
      { status: appointment.status, date: appointment.appointmentDate, startTime: appointment.startTime },
      clinicNow(this.config.clinicTimezone),
    );
    if (blocked) throw new ConflictException(blocked);
  }

  private async patientIdFor(userId: string): Promise<string> {
    const patient = await this.patients.findOneBy({ userId });
    if (!patient) throw new ForbiddenException('Only patients with a patient profile can book appointments.');
    return patient.id;
  }
}

function toAppointment(row: Appointment, payment?: PaymentSummary) {
  return {
    id: row.id,
    date: row.appointmentDate,
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    status: row.status,
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt,
    /** Who cancelled it: the patient's own cancel (or reschedule) or the doctor. Null while the appointment is active. */
    cancelledBy: row.cancelledBy?.role ?? null,
    rescheduledFromId: row.rescheduledFromId,
    createdAt: row.createdAt,
    /** While the booking waits for payment: when the held slot is released. Null otherwise. */
    holdExpiresAt: row.holdExpiresAt,
    /** Payment, receipt and refunds for this appointment, or null when it was free. */
    payment: payment ?? null,
    doctor: {
      id: row.doctor.id,
      name: row.doctor.user.name,
      specialty: row.doctor.specialty.name,
      consultationFee: row.doctor.consultationFee,
    },
    clinic: { name: row.doctor.clinic.name, address: row.doctor.clinic.address },
  };
}
