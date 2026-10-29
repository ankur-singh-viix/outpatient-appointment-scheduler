import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In, MoreThanOrEqual, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { withDoctorTitle } from '../common/names.js';
import { changeBlockedReason } from '../scheduling/appointment-rules.js';
import { ACTIVE_STATUSES, Appointment, Availability, Clinic, Doctor, ScheduleOverride, Specialty, User } from '../database/entities/index.js';
import { clinicNow, isValidDate } from '../scheduling/calendar.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { hhmm, toMinutes } from '../scheduling/slots.js';

export interface WeeklyHoursInput {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  capacity: number;
}

export interface DateOverrideInput {
  date: string;
  isAvailable: boolean;
  startTime?: string;
  endTime?: string;
  capacity?: number;
  reason?: string;
}

@Injectable()
export class DoctorPortalService {
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(Doctor) private readonly doctors: Repository<Doctor>,
    @InjectRepository(Appointment) private readonly appointmentsRepo: Repository<Appointment>,
    @InjectRepository(Availability) private readonly availabilityRepo: Repository<Availability>,
    @InjectRepository(ScheduleOverride) private readonly overrides: Repository<ScheduleOverride>,
    private readonly dataSource: DataSource,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Appointments booked with the signed-in doctor. `upcoming` = today onwards. */
  async appointments(user: AuthUser, scope: 'upcoming' | 'all') {
    const doctor = await this.profileFor(user);
    const where: FindOptionsWhere<Appointment> = { doctorId: doctor.id };
    if (scope === 'upcoming') where.appointmentDate = MoreThanOrEqual(clinicNow(this.config.clinicTimezone).date);

    const rows = await this.appointmentsRepo.find({
      where,
      relations: WITH_PATIENT,
      order: { appointmentDate: 'ASC', startTime: 'ASC' },
    });
    return rows.map(toDoctorAppointment);
  }

  /**
   * Cancels one of the signed-in doctor's own upcoming appointments, with a required reason that the patient will see.
   * The row is locked while it is checked and updated (so a doctor and a patient cancelling at once cannot both win),
   * and the doctor, time and status rules are enforced here, not only in the screen. The slot and its place in the
   * session's capacity are free again straight away, because only PENDING/CONFIRMED rows count.
   */
  async cancelAppointment(user: AuthUser, id: string, reason: string) {
    const doctor = await this.profileFor(user);
    const outcome = await this.dataSource.transaction(async (manager) => {
      // Looking it up by this doctor's id means someone else's appointment looks like a missing one.
      const appointment = await manager.findOne(Appointment, {
        where: { id, doctorId: doctor.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!appointment) throw new NotFoundException('Appointment not found.');
      const blocked = changeBlockedReason(
        { status: appointment.status, date: appointment.appointmentDate, startTime: appointment.startTime },
        clinicNow(this.config.clinicTimezone),
      );
      if (blocked) throw new ConflictException(blocked);
      appointment.status = 'CANCELLED';
      appointment.cancelReason = reason;
      appointment.cancelledAt = new Date();
      appointment.cancelledByUserId = user.id;
      appointment.holdExpiresAt = null;
      await manager.save(appointment);
      // When the clinic cancels, a paid booking is always refunded in full, decided in this same transaction.
      const money = await this.payments.onAppointmentCancelled(manager, appointment, 'DOCTOR');
      await this.notifications.appointmentCancelled(manager, appointment.id, { cancelledBy: 'DOCTOR', reason, refundNote: money.refundNote });
      return money;
    });
    await this.payments.afterCommit(outcome);
    const row = await this.appointmentsRepo.findOneOrFail({ where: { id }, relations: WITH_PATIENT });
    return toDoctorAppointment(row);
  }

  async availability(user: AuthUser) {
    const doctor = await this.profileFor(user);
    const today = clinicNow(this.config.clinicTimezone).date;
    const weekly = await this.availabilityRepo.find({
      where: { doctorId: doctor.id },
      order: { dayOfWeek: 'ASC', startTime: 'ASC' },
    });
    const overrides = await this.overrides.find({
      where: { doctorId: doctor.id, overrideDate: MoreThanOrEqual(today) },
      order: { overrideDate: 'ASC' },
    });
    return {
      consultationMinutes: doctor.consultationMinutes,
      defaultCapacity: doctor.defaultDailyCapacity,
      weekly: weekly.map((row) => ({
        dayOfWeek: row.dayOfWeek,
        startTime: hhmm(row.startTime),
        endTime: hhmm(row.endTime),
        capacity: row.capacity,
      })),
      overrides: overrides.map((row) => ({
        date: row.overrideDate,
        isAvailable: row.isAvailable,
        startTime: row.startTime && hhmm(row.startTime),
        endTime: row.endTime && hhmm(row.endTime),
        capacity: row.capacity,
        reason: row.reason,
      })),
    };
  }

  /** The signed-in doctor's own profile, as shown on the Profile tab. */
  async profile(user: AuthUser) {
    const doctor = await this.doctors.findOne({ where: { userId: user.id }, relations: { user: true } });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return {
      name: doctor.user.name,
      email: doctor.user.email,
      specialtyId: doctor.specialtyId,
      clinicId: doctor.clinicId,
      consultationFee: doctor.consultationFee,
      consultationMinutes: doctor.consultationMinutes,
      bio: doctor.bio,
    };
  }

  /**
   * Updates the doctor's own name, specialty, clinic, fee and bio. Moving to another clinic is refused while upcoming
   * appointments exist, because patients booked a visit at the current location. The doctor row lock is the one
   * booking takes, so a booking in flight is either counted here or waits.
   */
  async updateProfile(
    user: AuthUser,
    input: { name: string; specialtyId: string; clinicId: string; consultationFee: number; bio: string | null },
  ) {
    const doctor = await this.profileFor(user);
    const today = clinicNow(this.config.clinicTimezone).date;
    await this.dataSource.transaction(async (manager) => {
      await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
      if (!(await manager.existsBy(Specialty, { id: input.specialtyId }))) {
        throw new BadRequestException('specialtyId: choose one of the listed specialties.');
      }
      if (!(await manager.existsBy(Clinic, { id: input.clinicId }))) {
        throw new BadRequestException('clinicId: choose one of the listed clinics.');
      }
      if (input.clinicId !== doctor.clinicId) {
        const upcoming = await manager.count(Appointment, {
          where: { doctorId: doctor.id, appointmentDate: MoreThanOrEqual(today), status: In(ACTIVE_STATUSES) },
        });
        if (upcoming > 0) {
          throw new ConflictException(
            `You have ${upcoming} upcoming appointment${upcoming === 1 ? '' : 's'} at your current clinic. ` +
              'The clinic can only change when there are none, because patients booked a visit at that location.',
          );
        }
      }
      await manager.update(User, { id: user.id }, { name: withDoctorTitle(input.name) });
      await manager.update(
        Doctor,
        { id: doctor.id },
        { specialtyId: input.specialtyId, clinicId: input.clinicId, consultationFee: input.consultationFee, bio: input.bio?.trim() || null },
      );
    });
    return this.profile(user);
  }

  /**
   * Changes the slot length. Every working session must still fit at least one slot, and it is refused while
   * there are upcoming appointments, because they would stop lining up with the new slot grid (a longer slot
   * could overlap an existing booking). The doctor row lock is the one booking takes, so a booking in flight
   * either finishes first and is counted here, or waits and sees the new length.
   */
  async updateSettings(user: AuthUser, consultationMinutes: number) {
    const doctor = await this.profileFor(user);
    if (consultationMinutes !== doctor.consultationMinutes) {
      const today = clinicNow(this.config.clinicTimezone).date;
      const weekly = await this.availabilityRepo.findBy({ doctorId: doctor.id });
      for (const row of weekly) checkWindow(row.startTime, row.endTime, consultationMinutes, DAY_NAMES[row.dayOfWeek]);
      const overrides = await this.overrides.find({
        where: { doctorId: doctor.id, overrideDate: MoreThanOrEqual(today), isAvailable: true },
      });
      for (const row of overrides) {
        if (row.startTime && row.endTime) checkWindow(row.startTime, row.endTime, consultationMinutes, row.overrideDate);
      }

      await this.dataSource.transaction(async (manager) => {
        await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
        const upcoming = await manager.count(Appointment, {
          where: { doctorId: doctor.id, appointmentDate: MoreThanOrEqual(today), status: In(ACTIVE_STATUSES) },
        });
        if (upcoming > 0) {
          throw new ConflictException(
            `You have ${upcoming} upcoming appointment${upcoming === 1 ? '' : 's'}. Slot length can only change when there are none, ` +
              'because existing bookings would no longer line up with the new slots.',
          );
        }
        await manager.update(Doctor, { id: doctor.id }, { consultationMinutes });
      });
    }
    return this.availability(user);
  }

  /** Replaces the doctor's whole weekly schedule. Existing appointments are not changed. */
  async replaceWeekly(user: AuthUser, hours: WeeklyHoursInput[]) {
    const doctor = await this.profileFor(user);
    validateWeeklyHours(hours, doctor.consultationMinutes);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Availability, { doctorId: doctor.id });
      if (hours.length) {
        await manager.insert(
          Availability,
          hours.map((row) => ({ ...row, doctorId: doctor.id, schedulingMode: 'STREAM' as const })),
        );
      }
    });
    return this.availability(user);
  }

  /** Creates or replaces the exception for one date (a day off, or different hours). */
  async upsertOverride(user: AuthUser, input: DateOverrideInput) {
    const doctor = await this.profileFor(user);
    if (!isValidDate(input.date)) throw new BadRequestException('Date must be a valid YYYY-MM-DD date.');
    if (input.date < clinicNow(this.config.clinicTimezone).date) {
      throw new BadRequestException('You can only change today or future dates.');
    }
    if (input.isAvailable) {
      if (!input.startTime || !input.endTime || !input.capacity) {
        throw new BadRequestException('Start time, end time and capacity are required when you are available.');
      }
      checkWindow(input.startTime, input.endTime, doctor.consultationMinutes, input.date);
    }
    await this.overrides.upsert(
      {
        doctorId: doctor.id,
        overrideDate: input.date,
        isAvailable: input.isAvailable,
        startTime: input.isAvailable ? (input.startTime ?? null) : null,
        endTime: input.isAvailable ? (input.endTime ?? null) : null,
        capacity: input.isAvailable ? (input.capacity ?? null) : null,
        reason: input.reason?.trim() || null,
      },
      ['doctorId', 'overrideDate'],
    );
    return this.availability(user);
  }

  async deleteOverride(user: AuthUser, date: string) {
    const doctor = await this.profileFor(user);
    const result = await this.overrides.delete({ doctorId: doctor.id, overrideDate: date });
    if (!result.affected) throw new NotFoundException('No exception exists for that date.');
    return this.availability(user);
  }

  private async profileFor(user: AuthUser): Promise<Doctor> {
    const doctor = await this.doctors.findOneBy({ userId: user.id });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return doctor;
  }
}

const WITH_PATIENT = { patient: { user: true }, cancelledBy: true } as const;

function toDoctorAppointment(row: Appointment) {
  return {
    id: row.id,
    date: row.appointmentDate,
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    status: row.status,
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy?.role ?? null,
    bookedAt: row.createdAt,
    patient: { name: row.patient.user.name, phone: row.patient.phone },
  };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function checkWindow(startTime: string, endTime: string, consultationMinutes: number, label: string) {
  if (toMinutes(endTime) - toMinutes(startTime) < consultationMinutes) {
    throw new BadRequestException(
      `${label}: end time must be at least ${consultationMinutes} minutes after start time.`,
    );
  }
}

function validateWeeklyHours(hours: WeeklyHoursInput[], consultationMinutes: number) {
  for (const row of hours) checkWindow(row.startTime, row.endTime, consultationMinutes, DAY_NAMES[row.dayOfWeek]);

  // Sessions on the same day must not overlap, or a slot could belong to two sessions.
  for (let day = 0; day < 7; day++) {
    const sessions = hours
      .filter((row) => row.dayOfWeek === day)
      .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    for (let i = 1; i < sessions.length; i++) {
      if (toMinutes(sessions[i].startTime) < toMinutes(sessions[i - 1].endTime)) {
        throw new BadRequestException(`${DAY_NAMES[day]}: sessions overlap.`);
      }
    }
  }
}
