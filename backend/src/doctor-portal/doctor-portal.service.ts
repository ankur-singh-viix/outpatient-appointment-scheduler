import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere, In, MoreThanOrEqual, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { withDoctorTitle } from '../common/names.js';
import { changeBlockedReason } from '../scheduling/appointment-rules.js';
import { ACTIVE_STATUSES, Appointment, Availability, Clinic, Doctor, ScheduleOverride, Specialty, User, slotIntervalOf } from '../database/entities/index.js';
import { effectiveRangesIntersect, inheritedSettings, isCurrent, ruleProblem } from '../scheduling/availability-rules.js';
import { addDays, clinicNow, isValidDate } from '../scheduling/calendar.js';
import { loadDaySchedule, toRule } from '../scheduling/day-schedule.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { reconcileCoverage } from '../scheduling/schedule-reconciler.js';
import { hhmm, toMinutes } from '../scheduling/slots.js';

/** What every availability row (weekly or one-time) can say. Everything but the times is optional: a plain row is STREAM, one patient per slot, the doctor's slot length. */
export interface AvailabilityInput {
  startTime: string;
  endTime: string;
  /** STREAM only: the most bookings in the whole session. */
  capacity?: number | null;
  schedulingMode?: 'STREAM' | 'WAVE';
  slotDurationMinutes?: number | null;
  capacityPerSlot?: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface WeeklyHoursInput extends AvailabilityInput {
  dayOfWeek: number;
}

export interface OneTimeInput extends AvailabilityInput {
  date: string;
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
    // Rows that ended (their hours were changed from a later date) are history, not part of the schedule being edited.
    const weekly = (
      await this.availabilityRepo.find({
        where: { doctorId: doctor.id, recurrenceType: 'WEEKLY' },
        order: { dayOfWeek: 'ASC', startTime: 'ASC' },
      })
    ).filter((row) => isCurrent(row, today));
    const oneTime = await this.availabilityRepo.find({
      where: { doctorId: doctor.id, recurrenceType: 'ONE_TIME', specificDate: MoreThanOrEqual(today) },
      order: { specificDate: 'ASC', startTime: 'ASC' },
    });
    const overrides = await this.overrides.find({
      where: { doctorId: doctor.id, overrideDate: MoreThanOrEqual(today) },
      order: { overrideDate: 'ASC' },
    });
    return {
      consultationMinutes: doctor.consultationMinutes,
      /** Minutes between the starts of slots. Equals consultationMinutes unless the doctor chose a shorter (overlapping) interval. */
      slotIntervalMinutes: slotIntervalOf(doctor),
      /** True when the doctor chose their own interval, false while it simply follows the appointment length. */
      slotIntervalCustom: doctor.slotIntervalMinutes !== null,
      defaultCapacity: doctor.defaultDailyCapacity,
      weekly: weekly.map((row) => ({ id: row.id, dayOfWeek: row.dayOfWeek, ...describeRow(row) })),
      /** Sessions for one date only, from today on. They take priority over the weekly hours for the time they overlap. */
      oneTime: oneTime.map((row) => ({ id: row.id, date: row.specificDate, ...describeRow(row) })),
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
  async updateSettings(user: AuthUser, settings: { consultationMinutes?: number; slotIntervalMinutes?: number | null }) {
    const doctor = await this.profileFor(user);
    const consultationMinutes = settings.consultationMinutes ?? doctor.consultationMinutes;
    if (consultationMinutes !== doctor.consultationMinutes) {
      const today = clinicNow(this.config.clinicTimezone).date;
      const rows = await this.availabilityRepo.findBy({ doctorId: doctor.id });
      // Rows with a slot length of their own are not affected; the rest follow the doctor's length and must still fit it.
      for (const row of rows.filter((r) => isCurrent(r, today) && (r.slotDurationMinutes === null || r.slotDurationMinutes === doctor.consultationMinutes))) {
        checkWindow(row.startTime, row.endTime, consultationMinutes, rowLabel(row));
      }
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
        await manager.update(Availability, { doctorId: doctor.id, slotDurationMinutes: doctor.consultationMinutes }, { slotDurationMinutes: consultationMinutes });
      });
    }
    // The interval only changes WHICH start times are offered, never an existing booking, and booking refuses any overlap
    // with what is already booked, so unlike the appointment length it can change at any time. null = follow the length.
    if (settings.slotIntervalMinutes !== undefined && settings.slotIntervalMinutes !== doctor.slotIntervalMinutes) {
      await this.doctors.update({ id: doctor.id }, { slotIntervalMinutes: settings.slotIntervalMinutes });
    }
    return this.availability(user);
  }

  /**
   * Replaces the doctor's whole weekly schedule (one-time sessions are not touched). Existing appointments are not changed. Rows
   * that come back unchanged keep their id, so the appointments booked from them keep pointing at them.
   */
  async replaceWeekly(user: AuthUser, hours: WeeklyHoursInput[]) {
    const doctor = await this.profileFor(user);
    const wanted = hours.map((row) => ({
      ...this.completeRow(doctor, row),
      recurrenceType: 'WEEKLY' as const,
      dayOfWeek: row.dayOfWeek,
      specificDate: null,
    }));
    for (const row of wanted) this.assertRowValid(row, DAY_NAMES[row.dayOfWeek]);
    assertNoOverlap(wanted.map((row) => ({ ...row, label: DAY_NAMES[row.dayOfWeek], group: String(row.dayOfWeek) })));

    const restored = await this.dataSource.transaction(async (manager) => {
      await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
      // Only the rows the editor showed. Ended rows are history and must survive a save.
      const today = clinicNow(this.config.clinicTimezone).date;
      const existing = (await manager.find(Availability, { where: { doctorId: doctor.id, recurrenceType: 'WEEKLY' } })).filter((row) => isCurrent(row, today));
      const unused = new Map<string, Availability[]>();
      for (const row of existing) unused.set(rowKey(row), [...(unused.get(rowKey(row)) ?? []), row]);
      const toInsert = [];
      for (const row of wanted) {
        const same = unused.get(rowKey(row));
        if (same?.length) same.pop();
        else toInsert.push(row);
      }
      const toDelete = [...unused.values()].flat().map((row) => row.id);
      if (toDelete.length) await manager.delete(Availability, { id: In(toDelete) });
      if (toInsert.length) await manager.insert(Availability, toInsert.map((row) => ({ ...row, doctorId: doctor.id })));
      // Wider weekly hours may bring appointments that were waiting for a new time back inside them.
      return this.releaseWaiting(manager, doctor.id);
    });
    return { ...(await this.availability(user)), restoredAppointments: restored };
  }

  /** Adds a session for one date only. It takes priority over the weekly hours for the time it overlaps. */
  async addOneTime(user: AuthUser, input: OneTimeInput) {
    const doctor = await this.profileFor(user);
    if (!isValidDate(input.date)) throw new BadRequestException('Date must be a valid YYYY-MM-DD date.');
    if (input.date < clinicNow(this.config.clinicTimezone).date) throw new BadRequestException('You can only add sessions for today or future dates.');
    const row = { ...this.completeRow(doctor, input), recurrenceType: 'ONE_TIME' as const, dayOfWeek: null, specificDate: input.date };
    this.assertRowValid(row, input.date);

    const restored = await this.dataSource.transaction(async (manager) => {
      await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
      const sameDay = await manager.find(Availability, { where: { doctorId: doctor.id, recurrenceType: 'ONE_TIME', specificDate: input.date } });
      assertNoOverlap([
        ...sameDay.map((other) => ({ ...rowFields(other), label: input.date, group: input.date })),
        { ...row, label: input.date, group: input.date },
      ]);
      await manager.insert(Availability, { ...row, doctorId: doctor.id });
      // The usual reason for adding a session: a patient was left outside the hours and needs somewhere to go.
      return this.releaseWaiting(manager, doctor.id);
    });
    return { ...(await this.availability(user)), restoredAppointments: restored };
  }

  /** Deletes a one-time session, unless patients have booked in it: those appointments must be cancelled first. */
  async deleteOneTime(user: AuthUser, id: string) {
    const doctor = await this.profileFor(user);
    await this.dataSource.transaction(async (manager) => {
      await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
      const row = await manager.findOneBy(Availability, { id, doctorId: doctor.id, recurrenceType: 'ONE_TIME' });
      if (!row || !row.specificDate) throw new NotFoundException('No one-time session exists with that id.');
      await this.payments.releaseLapsedHolds(manager, doctor.id);
      await this.assertNoBookings(manager, doctor.id, row.specificDate, row.startTime, row.endTime);
      await manager.delete(Availability, { id: row.id });
    });
    return this.availability(user);
  }

  /**
   * The doctor's next few days as patients see them, from the same slot rules booking uses (so it cannot disagree with what a
   * patient is offered): per date, its sessions, and every slot with its status and places left. A date exception is returned too,
   * so a day off or a blocked time is visible. Limited to the booking window.
   */
  async schedule(user: AuthUser, days: number) {
    const doctor = await this.profileFor(user);
    const today = clinicNow(this.config.clinicTimezone).date;
    const span = Math.min(days, this.config.bookingWindowDays + 1);
    const result = [];
    for (let offset = 0; offset < span; offset++) {
      const date = addDays(today, offset);
      const day = await loadDaySchedule(this.dataSource.manager, doctor.id, date, {
        timeZone: this.config.clinicTimezone,
        bookingWindowDays: this.config.bookingWindowDays,
      });
      const exception = await this.overrides.findOneBy({ doctorId: doctor.id, overrideDate: date });
      const sessions = day.sessions.map((session) => ({
        availabilityId: session.availabilityId ?? null,
        source: session.source,
        mode: session.mode ?? 'STREAM',
        startTime: session.startTime,
        endTime: session.endTime,
        slotMinutes: session.slotMinutes ?? doctor.consultationMinutes,
        capacityPerSlot: session.capacityPerSlot ?? 1,
        capacity: session.capacity,
        booked: session.booked,
        remaining: session.remaining,
        // A slot belongs to the session it was cut from (sessions can overlap in time).
        slots: day.slots.filter(
          (slot) => slot.startTime >= session.startTime && slot.startTime < session.endTime && (slot.availabilityId ?? null) === (session.availabilityId ?? null),
        ),
      }));
      if (sessions.length === 0 && !exception) continue;
      result.push({
        date,
        unavailableReason: day.unavailableReason,
        exception: exception
          ? {
              isAvailable: exception.isAvailable,
              startTime: exception.startTime && hhmm(exception.startTime),
              endTime: exception.endTime && hhmm(exception.endTime),
              reason: exception.reason,
            }
          : null,
        sessions,
      });
    }
    return { days: result };
  }

  /**
   * Cancels a time on one date (one slot, or a whole session) by blocking it: patients can no longer book it, and nothing else on
   * the day changes. Refused when patients have booked in that time (cancel those appointments first, so each patient is told and
   * refunded), and when the date already has an exception (a date has one: change it under Date exceptions).
   */
  async cancelTime(user: AuthUser, input: { date: string; startTime: string; endTime: string; reason?: string }) {
    const doctor = await this.profileFor(user);
    if (!isValidDate(input.date)) throw new BadRequestException('Date must be a valid YYYY-MM-DD date.');
    if (input.date < clinicNow(this.config.clinicTimezone).date) throw new BadRequestException('You can only cancel today or future dates.');
    if (toMinutes(input.endTime) <= toMinutes(input.startTime)) throw new BadRequestException('The end of the time must be after its start.');

    await this.dataSource.transaction(async (manager) => {
      await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
      await this.payments.releaseLapsedHolds(manager, doctor.id);
      if (await manager.existsBy(ScheduleOverride, { doctorId: doctor.id, overrideDate: input.date })) {
        throw new ConflictException('This date already has an exception (a day off, a blocked time or different hours). Change it under Date exceptions.');
      }
      await this.assertNoBookings(manager, doctor.id, input.date, input.startTime, input.endTime);
      await manager.insert(ScheduleOverride, {
        doctorId: doctor.id,
        overrideDate: input.date,
        isAvailable: false,
        startTime: input.startTime,
        endTime: input.endTime,
        capacity: null,
        reason: input.reason?.trim() || 'Cancelled by doctor',
      });
    });
    return this.availability(user);
  }

  /** Throws a 409 when active appointments share time with the window: the doctor cancels those first (reason, refund and notice). */
  private async assertNoBookings(manager: EntityManager, doctorId: string, date: string, startTime: string, endTime: string) {
    const booked = await manager
      .createQueryBuilder(Appointment, 'appointment')
      .where('appointment.doctorId = :doctorId AND appointment.appointmentDate = :date', { doctorId, date })
      .andWhere('appointment.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .andWhere('appointment.startTime < :endTime AND appointment.endTime > :startTime', { startTime, endTime })
      .getCount();
    if (booked > 0) {
      throw new ConflictException(
        `${booked} patient${booked === 1 ? ' has' : 's have'} an appointment in this time. Cancel ${booked === 1 ? 'it' : 'those appointments'} from Appointments first, so each patient is told and refunded.`,
      );
    }
  }

  /** Fills in what a request left out: STREAM, the doctor's slot length, one patient per slot. WAVE has no session-wide cap. */
  private completeRow(doctor: Doctor, input: AvailabilityInput) {
    const schedulingMode = input.schedulingMode ?? 'STREAM';
    return {
      startTime: input.startTime,
      endTime: input.endTime,
      schedulingMode,
      slotDurationMinutes: input.slotDurationMinutes ?? doctor.consultationMinutes,
      capacityPerSlot: input.capacityPerSlot ?? 1,
      capacity: schedulingMode === 'WAVE' ? null : (input.capacity ?? null),
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
    };
  }

  private assertRowValid(
    row: ReturnType<DoctorPortalService['completeRow']> & { recurrenceType: 'WEEKLY' | 'ONE_TIME'; dayOfWeek: number | null; specificDate: string | null },
    label: string,
  ) {
    for (const date of [row.effectiveFrom, row.effectiveTo]) {
      if (date !== null && !isValidDate(date)) throw new BadRequestException(`${label}: effective dates must be valid YYYY-MM-DD dates.`);
    }
    checkWindow(row.startTime, row.endTime, row.slotDurationMinutes, label);
    const problem = ruleProblem(row);
    if (problem) throw new BadRequestException(`${label}: ${problem}`);
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
      // The new hours replace the day and use the slot length the day would otherwise have had.
      const rules = (await this.availabilityRepo.findBy({ doctorId: doctor.id })).map(toRule);
      const inherited = inheritedSettings(rules, input.date, { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity });
      checkWindow(input.startTime, input.endTime, inherited.slotMinutes, input.date);
    } else if (input.startTime || input.endTime) {
      // A day off with times blocks only that part of the day.
      if (!input.startTime || !input.endTime) throw new BadRequestException('Give both a start and an end time to block part of the day, or neither to block all of it.');
      if (toMinutes(input.endTime) <= toMinutes(input.startTime)) throw new BadRequestException('The end of the blocked time must be after its start.');
    }
    // Under the doctor lock like every other change of hours, so the bookkeeping for appointments waiting on a new time can follow.
    const restored = await this.dataSource.transaction(async (manager) => {
      await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
      await manager.upsert(
        ScheduleOverride,
        {
          doctorId: doctor.id,
          overrideDate: input.date,
          isAvailable: input.isAvailable,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          capacity: input.isAvailable ? (input.capacity ?? null) : null,
          reason: input.reason?.trim() || null,
        },
        ['doctorId', 'overrideDate'],
      );
      // Replacement hours can cover appointments the day off or the old hours left out. A day off or a block only removes time.
      return input.isAvailable ? this.releaseWaiting(manager, doctor.id) : 0;
    });
    return { ...(await this.availability(user)), restoredAppointments: restored };
  }

  async deleteOverride(user: AuthUser, date: string) {
    const doctor = await this.profileFor(user);
    const restored = await this.dataSource.transaction(async (manager) => {
      await manager.findOne(Doctor, { where: { id: doctor.id }, lock: { mode: 'pessimistic_write' } });
      const result = await manager.delete(ScheduleOverride, { doctorId: doctor.id, overrideDate: date });
      if (!result.affected) throw new NotFoundException('No exception exists for that date.');
      // Lifting a day off or a block gives the date its normal hours back.
      return this.releaseWaiting(manager, doctor.id);
    });
    return { ...(await this.availability(user)), restoredAppointments: restored };
  }

  /** After hours may have widened: lets appointments that were waiting for a new time and are inside the hours again go (see reconcileCoverage). */
  private async releaseWaiting(manager: EntityManager, doctorId: string): Promise<number> {
    return (await reconcileCoverage(manager, doctorId, clinicNow(this.config.clinicTimezone))).restored;
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

/** Availability rows in the same group (a weekday, or a date) must not overlap in time while their effective dates also overlap. */
function assertNoOverlap(
  rows: { startTime: string; endTime: string; effectiveFrom: string | null; effectiveTo: string | null; label: string; group: string }[],
) {
  for (const group of new Set(rows.map((row) => row.group))) {
    const sessions = rows.filter((row) => row.group === group).sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        if (toMinutes(sessions[j].startTime) < toMinutes(sessions[i].endTime) && effectiveRangesIntersect(sessions[i], sessions[j])) {
          throw new BadRequestException(`${sessions[i].label}: sessions overlap.`);
        }
      }
    }
  }
}

const rowLabel = (row: Availability) => (row.dayOfWeek !== null ? DAY_NAMES[row.dayOfWeek] : (row.specificDate ?? 'One-time session'));

/** The row fields that decide whether two rows are "the same", normalised so a row from the database and one from a request compare. */
function rowFields(
  row: Pick<Availability, 'startTime' | 'endTime' | 'capacity' | 'schedulingMode' | 'slotDurationMinutes' | 'capacityPerSlot' | 'effectiveFrom' | 'effectiveTo'>,
) {
  return {
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    capacity: row.capacity,
    schedulingMode: row.schedulingMode,
    slotDurationMinutes: row.slotDurationMinutes,
    capacityPerSlot: row.capacityPerSlot,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

function rowKey(row: Parameters<typeof rowFields>[0] & { dayOfWeek: number | null }): string {
  return JSON.stringify([row.dayOfWeek, ...Object.values(rowFields(row))]);
}

/** How one availability row is shown to the doctor. */
const describeRow = (row: Availability) => rowFields(row);
