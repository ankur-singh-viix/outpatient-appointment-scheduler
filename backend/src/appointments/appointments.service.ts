import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { Appointment, Doctor, Patient } from '../database/entities/index.js';
import { isUniqueViolation } from '../database/errors.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import type { PaymentSummary } from '../payments/payment-summary.js';
import { changeBlockedReason } from '../scheduling/appointment-rules.js';
import { clinicNow } from '../scheduling/calendar.js';
import { loadDaySchedule } from '../scheduling/day-schedule.js';
import { hhmm, type Slot } from '../scheduling/slots.js';

export interface BookAppointmentInput {
  doctorId: string;
  date: string;
  startTime: string;
}

export interface RescheduleInput {
  date: string;
  startTime: string;
}

const WITH_DOCTOR = { doctor: { user: true, specialty: true, clinic: true }, cancelledBy: true } as const;
const SLOT_TAKEN = 'That time slot has just been booked. Please choose another.';

/** Throws unless the slot exists and can still be booked. Shared by booking and rescheduling. */
function assertBookable(slot: Slot | undefined): asserts slot is Slot {
  if (!slot) throw new BadRequestException('The doctor has no appointment slot at that time.');
  if (slot.status === 'PAST') throw new BadRequestException('That time slot has already passed.');
  if (slot.status === 'BOOKED') throw new ConflictException(SLOT_TAKEN);
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
   * 3. Insert only if the slot exists, is in the future, is free and its session isn't full.
   * The partial unique index on (doctor_id, appointment_date, start_time) is the final backstop.
   */
  async book(user: AuthUser, input: BookAppointmentInput) {
    const patientId = await this.patientIdFor(user.id);

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

        // With payments on, a booking with a fee is a HOLD: the slot is reserved but unconfirmed until payment succeeds.
        // The fee is read from the database here, never from the request. Without payments, or for a free doctor, it is confirmed as before.
        needsPayment = this.payments.enabled && doctor.consultationFee > 0;
        const saved = await manager.save(
          manager.create(Appointment, {
            patientId,
            doctorId: input.doctorId,
            bookedByUserId: user.id,
            appointmentDate: input.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            status: needsPayment ? 'PENDING' : 'CONFIRMED',
            holdExpiresAt: needsPayment ? new Date(Date.now() + this.payments.holdMinutes * 60_000) : null,
          }),
        );
        if (!needsPayment) await this.notifications.bookingConfirmed(manager, saved.id);
        return saved.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(SLOT_TAKEN);
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
    const patientId = await this.patientIdFor(user.id);
    const outcome = await this.dataSource.transaction(async (manager) => {
      const appointment = await this.lockOwn(manager, id, patientId);
      this.assertChangeable(appointment);
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
    const patientId = await this.patientIdFor(user.id);
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

        const saved = await manager.save(
          manager.create(Appointment, {
            patientId,
            doctorId: current.doctorId,
            bookedByUserId: user.id,
            appointmentDate: input.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
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
      if (isUniqueViolation(error)) throw new ConflictException(SLOT_TAKEN);
      throw error;
    }
  }

  async listForPatient(user: AuthUser) {
    const patientId = await this.patientIdFor(user.id);
    const rows = await this.appointments.find({
      where: { patientId },
      relations: WITH_DOCTOR,
      order: { appointmentDate: 'DESC', startTime: 'DESC' },
    });
    const payments = await this.payments.summariesFor(rows.map((row) => row.id));
    return rows.map((row) => toAppointment(row, payments.get(row.id)));
  }

  private async findOne(id: string) {
    const row = await this.appointments.findOneOrFail({ where: { id }, relations: WITH_DOCTOR });
    return toAppointment(row, (await this.payments.summariesFor([id])).get(id));
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
