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

    try {
      const appointmentId = await this.dataSource.transaction(async (manager) => {
        const schedule = await loadDaySchedule(manager, input.doctorId, input.date, {
          timeZone: this.config.clinicTimezone,
          bookingWindowDays: this.config.bookingWindowDays,
          lockDoctor: true,
        });

        const slot = schedule.slots.find((candidate) => candidate.startTime === input.startTime);
        assertBookable(slot);

        const saved = await manager.save(
          manager.create(Appointment, {
            patientId,
            doctorId: input.doctorId,
            bookedByUserId: user.id,
            appointmentDate: input.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            status: 'CONFIRMED',
          }),
        );
        return saved.id;
      });
      return this.findOne(appointmentId);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(SLOT_TAKEN);
      throw error;
    }
  }

  /**
   * Cancels one of the signed-in patient's upcoming appointments. The row is locked while it is checked and
   * updated, so two cancels (or a cancel racing a reschedule) cannot both succeed. A cancelled appointment no
   * longer counts toward its slot or its session's capacity, because only PENDING/CONFIRMED rows do.
   */
  async cancel(user: AuthUser, id: string, reason?: string) {
    const patientId = await this.patientIdFor(user.id);
    await this.dataSource.transaction(async (manager) => {
      const appointment = await this.lockOwn(manager, id, patientId);
      this.assertChangeable(appointment);
      appointment.status = 'CANCELLED';
      appointment.cancelReason = reason?.trim() || 'Cancelled by patient';
      appointment.cancelledAt = new Date();
      appointment.cancelledByUserId = user.id;
      await manager.save(appointment);
    });
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
        const current = await this.lockOwn(manager, id, patientId);
        this.assertChangeable(current);

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
        return saved.id;
      });
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
    return rows.map(toAppointment);
  }

  private async findOne(id: string) {
    const row = await this.appointments.findOneOrFail({ where: { id }, relations: WITH_DOCTOR });
    return toAppointment(row);
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

function toAppointment(row: Appointment) {
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
    doctor: {
      id: row.doctor.id,
      name: row.doctor.user.name,
      specialty: row.doctor.specialty.name,
      consultationFee: row.doctor.consultationFee,
    },
    clinic: { name: row.doctor.clinic.name, address: row.doctor.clinic.address },
  };
}
