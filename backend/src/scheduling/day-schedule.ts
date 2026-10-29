import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { ACTIVE_STATUSES, Appointment, Availability, Doctor, ScheduleOverride } from '../database/entities/index.js';
import { addDays, clinicNow, dayOfWeek, isValidDate } from './calendar.js';
import { buildSlots, resolveSessions, type DateOverride, type WeeklyHours } from './slots.js';

/**
 * Loads one doctor's schedule for one date and computes its sessions and slots.
 * Used both to display slots and, inside the booking transaction, to validate a booking.
 * `lockDoctor` takes a row lock (FOR UPDATE) so concurrent bookings for the same doctor run one at a time;
 * it only works on the manager of an open transaction.
 */
export async function loadDaySchedule(
  manager: EntityManager,
  doctorId: string,
  date: string,
  options: { timeZone: string; bookingWindowDays: number; lockDoctor?: boolean },
) {
  if (!isValidDate(date)) throw new BadRequestException('Date must be a valid YYYY-MM-DD date.');
  const today = clinicNow(options.timeZone);
  const lastBookableDate = addDays(today.date, options.bookingWindowDays);
  if (date > lastBookableDate) {
    throw new BadRequestException(`Appointments can be booked up to ${options.bookingWindowDays} days ahead.`);
  }

  const doctor = await manager.findOne(Doctor, {
    where: { id: doctorId },
    ...(options.lockDoctor ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
  if (!doctor) throw new NotFoundException('Doctor not found.');

  // Sequential on purpose: `manager` may be a single transaction connection, which can't run queries in parallel.
  const overrideRow = await manager.findOneBy(ScheduleOverride, { doctorId, overrideDate: date });
  const weeklyRows = await manager.findBy(Availability, { doctorId, dayOfWeek: dayOfWeek(date) });
  const activeRows = await manager.find(Appointment, {
    select: { startTime: true, status: true, holdExpiresAt: true },
    where: { doctorId, appointmentDate: date, status: In(ACTIVE_STATUSES) },
  });
  // An unpaid hold whose time has run out no longer occupies its slot, even before the background worker cancels it, so a
  // slow or sleeping worker can never keep a slot looking taken. Booking releases the row itself before it inserts.
  const nowMs = Date.now();
  const bookedRows = activeRows.filter(
    (row) => !(row.status === 'PENDING' && row.holdExpiresAt !== null && row.holdExpiresAt.getTime() <= nowMs),
  );

  const override: DateOverride | null = overrideRow
    ? {
        isAvailable: overrideRow.isAvailable,
        startTime: overrideRow.startTime,
        endTime: overrideRow.endTime,
        capacity: overrideRow.capacity,
        reason: overrideRow.reason,
      }
    : null;
  const weekly: WeeklyHours[] = weeklyRows.map((row) => ({
    startTime: row.startTime,
    endTime: row.endTime,
    capacity: row.capacity,
  }));

  const sessions = resolveSessions(override, weekly, doctor.defaultDailyCapacity);
  const isPastDate = date < today.date;
  // For past dates every slot is in the past; for today, slots up to "now" are.
  const cutoff = isPastDate ? '23:59' : date === today.date ? today.time : null;
  const result = buildSlots(
    sessions,
    doctor.consultationMinutes,
    bookedRows.map((row) => row.startTime),
    cutoff,
  );

  return {
    doctorId,
    date,
    consultationMinutes: doctor.consultationMinutes,
    unavailableReason: override && !override.isAvailable ? (override.reason ?? 'Not available on this date') : null,
    ...result,
  };
}
