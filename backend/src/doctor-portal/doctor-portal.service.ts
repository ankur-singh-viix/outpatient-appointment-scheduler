import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, MoreThanOrEqual, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { Appointment, Availability, Doctor, ScheduleOverride } from '../database/entities/index.js';
import { clinicNow, isValidDate } from '../scheduling/calendar.js';
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
  ) {}

  /** Appointments booked with the signed-in doctor. `upcoming` = today onwards. */
  async appointments(user: AuthUser, scope: 'upcoming' | 'all') {
    const doctor = await this.profileFor(user);
    const where: FindOptionsWhere<Appointment> = { doctorId: doctor.id };
    if (scope === 'upcoming') where.appointmentDate = MoreThanOrEqual(clinicNow(this.config.clinicTimezone).date);

    const rows = await this.appointmentsRepo.find({
      where,
      relations: { patient: { user: true } },
      order: { appointmentDate: 'ASC', startTime: 'ASC' },
    });
    return rows.map((row) => ({
      id: row.id,
      date: row.appointmentDate,
      startTime: hhmm(row.startTime),
      endTime: hhmm(row.endTime),
      status: row.status,
      bookedAt: row.createdAt,
      patient: { name: row.patient.user.name, phone: row.patient.phone },
    }));
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
