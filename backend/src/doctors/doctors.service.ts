import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { loadConfig } from '../config.js';
import { Doctor, Specialty } from '../database/entities/index.js';
import { loadDaySchedule } from '../scheduling/day-schedule.js';
import { hhmm } from '../scheduling/slots.js';

@Injectable()
export class DoctorsService {
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(Doctor) private readonly doctors: Repository<Doctor>,
    @InjectRepository(Specialty) private readonly specialtiesRepo: Repository<Specialty>,
    private readonly dataSource: DataSource,
  ) {}

  /** Doctors with their user, specialty, clinic and weekly sessions loaded. */
  private query() {
    return this.doctors
      .createQueryBuilder('doctor')
      .innerJoinAndSelect('doctor.user', 'user')
      .innerJoinAndSelect('doctor.specialty', 'specialty')
      .innerJoinAndSelect('doctor.clinic', 'clinic')
      .leftJoinAndSelect('doctor.availability', 'availability');
  }

  async list(search?: string, specialtyId?: string) {
    const query = this.query()
      .orderBy('user.name', 'ASC')
      .addOrderBy('availability.dayOfWeek', 'ASC')
      .addOrderBy('availability.startTime', 'ASC');
    if (search?.trim()) {
      query.andWhere('(user.name ILIKE :term OR specialty.name ILIKE :term)', { term: `%${escapeLike(search.trim())}%` });
    }
    if (specialtyId) query.andWhere('specialty.id = :specialtyId', { specialtyId });
    return (await query.getMany()).map(toDoctor);
  }

  async get(id: string) {
    const doctor = await this.query()
      .where('doctor.id = :id', { id })
      .orderBy('availability.dayOfWeek', 'ASC')
      .addOrderBy('availability.startTime', 'ASC')
      .getOne();
    if (!doctor) throw new NotFoundException('Doctor not found.');
    return toDoctor(doctor);
  }

  slots(id: string, date: string) {
    return loadDaySchedule(this.dataSource.manager, id, date, {
      timeZone: this.config.clinicTimezone,
      bookingWindowDays: this.config.bookingWindowDays,
    });
  }

  async specialties() {
    const rows = await this.specialtiesRepo.find({ select: { id: true, name: true }, order: { name: 'ASC' } });
    return rows.map(({ id, name }) => ({ id, name }));
  }
}

function toDoctor(doctor: Doctor) {
  return {
    id: doctor.id,
    name: doctor.user.name,
    bio: doctor.bio,
    consultationFee: doctor.consultationFee,
    consultationMinutes: doctor.consultationMinutes,
    specialty: { id: doctor.specialty.id, name: doctor.specialty.name },
    clinic: { name: doctor.clinic.name, address: doctor.clinic.address },
    weeklyHours: doctor.availability.map((a) => ({
      dayOfWeek: a.dayOfWeek,
      startTime: hhmm(a.startTime),
      endTime: hhmm(a.endTime),
    })),
  };
}

/** Treats % and _ in user input as literal characters in ILIKE patterns. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
