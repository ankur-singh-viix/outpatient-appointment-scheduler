import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { Appointment, Patient } from '../database/entities/index.js';
import { isUniqueViolation } from '../database/errors.js';
import { loadDaySchedule } from '../scheduling/day-schedule.js';
import { hhmm } from '../scheduling/slots.js';

export interface BookAppointmentInput {
  doctorId: string;
  date: string;
  startTime: string;
}

const WITH_DOCTOR = { doctor: { user: true, specialty: true, clinic: true } } as const;

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
        if (!slot) throw new BadRequestException('The doctor has no appointment slot at that time.');
        if (slot.status === 'PAST') throw new BadRequestException('That time slot has already passed.');
        if (slot.status === 'BOOKED') throw new ConflictException('That time slot has just been booked. Please choose another.');
        if (slot.status === 'FULL') throw new ConflictException('This session has reached its booking capacity. Please choose another session or date.');

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
      if (isUniqueViolation(error)) {
        throw new ConflictException('That time slot has just been booked. Please choose another.');
      }
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
