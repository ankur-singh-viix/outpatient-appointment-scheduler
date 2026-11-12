import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, In, Repository } from 'typeorm';
import { loadConfig } from '../config.js';
import { ACTIVE_STATUSES, Appointment, Availability, Clinic, Doctor, ScheduleOverride, Specialty, slotIntervalOf } from '../database/entities/index.js';
import { addDays, clinicNow } from '../scheduling/calendar.js';
import { isCurrent } from '../scheduling/availability-rules.js';
import { loadDaySchedule, toRule } from '../scheduling/day-schedule.js';
import { daySummary } from '../scheduling/elastic.js';
import { findNextAvailable, type NextSlot } from '../scheduling/next-available.js';
import { bookedLoader } from '../scheduling/open-times.js';
import { toOverride } from '../scheduling/outside-hours.js';
import { hhmm, type DateOverride } from '../scheduling/slots.js';

/** How far ahead a card looks for the "next available" time. */
const NEXT_SLOT_DAYS = 14;

@Injectable()
export class DoctorsService {
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(Doctor) private readonly doctors: Repository<Doctor>,
    @InjectRepository(Specialty) private readonly specialtiesRepo: Repository<Specialty>,
    @InjectRepository(Clinic) private readonly clinicsRepo: Repository<Clinic>,
    private readonly dataSource: DataSource,
  ) {}

  /** Clinics a new doctor can join during sign-up. */
  async clinics() {
    const rows = await this.clinicsRepo.find({ order: { name: 'ASC' } });
    return rows.map((row) => ({ id: row.id, name: row.name, address: row.address }));
  }

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
    const rows = await query.getMany();
    const next = await this.nextSlots(rows);
    const today = clinicNow(this.config.clinicTimezone).date;
    return rows.map((row) => ({ ...toDoctor(row, today), nextAvailable: next.get(row.id) ?? null }));
  }

  /**
   * The first bookable slot for each doctor, worked out from a few bulk queries (exceptions and active appointments for
   * the next two weeks) and the same pure slot rules that booking uses, not one query per doctor per day.
   */
  private async nextSlots(rows: Doctor[]): Promise<Map<string, NextSlot | null>> {
    const result = new Map<string, NextSlot | null>();
    if (rows.length === 0) return result;

    const today = clinicNow(this.config.clinicTimezone);
    const last = addDays(today.date, NEXT_SLOT_DAYS - 1);
    const doctorIds = rows.map((row) => row.id);
    const overrideRows = await this.dataSource.manager.find(ScheduleOverride, {
      where: { doctorId: In(doctorIds), overrideDate: Between(today.date, last) },
    });
    const bookedRows = await this.dataSource.manager.find(Appointment, {
      select: { doctorId: true, appointmentDate: true, startTime: true, endTime: true },
      where: { doctorId: In(doctorIds), appointmentDate: Between(today.date, last), status: In(ACTIVE_STATUSES) },
    });

    for (const doctor of rows) {
      const overrides = new Map<string, DateOverride>();
      for (const row of overrideRows.filter((r) => r.doctorId === doctor.id)) {
        overrides.set(row.overrideDate, {
          isAvailable: row.isAvailable,
          startTime: row.startTime,
          endTime: row.endTime,
          capacity: row.capacity,
          reason: row.reason,
        });
      }
      const booked = new Map<string, { startTime: string; endTime: string }[]>();
      for (const row of bookedRows.filter((r) => r.doctorId === doctor.id)) {
        booked.set(row.appointmentDate, [...(booked.get(row.appointmentDate) ?? []), { startTime: row.startTime, endTime: row.endTime }]);
      }
      result.set(
        doctor.id,
        findNextAvailable({
          consultationMinutes: doctor.consultationMinutes,
          slotIntervalMinutes: slotIntervalOf(doctor),
          defaultCapacity: doctor.defaultDailyCapacity,
          weekly: [],
          rules: doctor.availability.map(toRule),
          overrides,
          booked,
          today,
          days: NEXT_SLOT_DAYS,
        }),
      );
    }
    return result;
  }

  async get(id: string) {
    const doctor = await this.query()
      .where('doctor.id = :id', { id })
      .orderBy('availability.dayOfWeek', 'ASC')
      .addOrderBy('availability.startTime', 'ASC')
      .getOne();
    if (!doctor) throw new NotFoundException('Doctor not found.');
    const next = await this.nextSlots([doctor]);
    return { ...toDoctor(doctor, clinicNow(this.config.clinicTimezone).date), nextAvailable: next.get(doctor.id) ?? null };
  }

  /** The day's slots with their status. `availableOnly` keeps just the slots that can be booked right now (a free seat, not past, not full). */
  async slots(id: string, date: string, availableOnly = false) {
    const { booked: _booked, ...schedule } = await loadDaySchedule(this.dataSource.manager, id, date, {
      timeZone: this.config.clinicTimezone,
      bookingWindowDays: this.config.bookingWindowDays,
    });
    return availableOnly ? { ...schedule, slots: schedule.slots.filter((slot) => slot.status === 'AVAILABLE') } : schedule;
  }

  /**
   * Which dates in the next `days` days have sessions, and how much room each has left, worked out with the same slot rules booking
   * uses (so a date shown as open can really be booked). Dates with no sessions, such as a day off, are left out. Public, like slots.
   */
  async openDays(id: string, days: number) {
    const manager = this.dataSource.manager;
    const doctor = await manager.findOneBy(Doctor, { id });
    if (!doctor) throw new NotFoundException('Doctor not found.');
    const clock = clinicNow(this.config.clinicTimezone);
    const span = Math.min(days, this.config.bookingWindowDays + 1);
    const lastDate = addDays(clock.date, span - 1);
    const rules = (await manager.findBy(Availability, { doctorId: id })).map(toRule);
    const overrides = new Map((await manager.find(ScheduleOverride, { where: { doctorId: id, overrideDate: Between(clock.date, lastDate) } })).map((row) => [row.overrideDate, toOverride(row)]));
    const elastic = { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity, slotIntervalMinutes: slotIntervalOf(doctor) };
    const bookedOn = bookedLoader(manager, id, lastDate);
    const result: { date: string; open: number; places: number }[] = [];
    for (let date = clock.date; date <= lastDate; date = addDays(date, 1)) {
      const summary = daySummary(date, rules, overrides.get(date) ?? null, elastic, await bookedOn(date), date === clock.date ? clock.time : null);
      if (summary.total > 0) result.push({ date, open: summary.open, places: summary.places });
    }
    return { days: result };
  }

  async specialties() {
    const rows = await this.specialtiesRepo.find({ select: { id: true, name: true }, order: { name: 'ASC' } });
    return rows.map(({ id, name }) => ({ id, name }));
  }
}

function toDoctor(doctor: Doctor, today: string) {
  return {
    id: doctor.id,
    name: doctor.user.name,
    bio: doctor.bio,
    consultationFee: doctor.consultationFee,
    consultationMinutes: doctor.consultationMinutes,
    slotIntervalMinutes: slotIntervalOf(doctor),
    specialty: { id: doctor.specialty.id, name: doctor.specialty.name },
    clinic: { name: doctor.clinic.name, address: doctor.clinic.address },
    // Repeating weekly hours only: a one-time session is for one date and has no weekday.
    weeklyHours: doctor.availability
      .filter((a) => a.recurrenceType === 'WEEKLY' && isCurrent(a, today))
      .map((a) => ({
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
