import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { ACTIVE_STATUSES, Appointment, Availability, Doctor, ScheduleOverride, slotIntervalOf } from '../database/entities/index.js';
import { addDays, clinicNow, isValidDate } from './calendar.js';
import { resolveDay, type AvailabilityRule } from './availability-rules.js';
import { buildSlots, type BookedWindow, type DateOverride } from './slots.js';

/** An availability row as the pure scheduling rules see it. */
export function toRule(row: Availability): AvailabilityRule {
  return {
    id: row.id,
    recurrenceType: row.recurrenceType,
    dayOfWeek: row.dayOfWeek,
    specificDate: row.specificDate,
    startTime: row.startTime,
    endTime: row.endTime,
    capacity: row.capacity,
    schedulingMode: row.schedulingMode,
    slotDurationMinutes: row.slotDurationMinutes,
    capacityPerSlot: row.capacityPerSlot,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

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
  options: { timeZone: string; bookingWindowDays: number; lockDoctor?: boolean; /** Leave this appointment out, as the move of it releases its old time first. */ ignoreAppointmentId?: string },
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
  const ruleRows = await manager.findBy(Availability, { doctorId });
  const activeRows = await manager.find(Appointment, {
    select: { id: true, startTime: true, endTime: true, slotNumber: true, status: true, holdExpiresAt: true },
    where: { doctorId, appointmentDate: date, status: In(ACTIVE_STATUSES) },
  });
  // An unpaid hold whose time has run out no longer occupies its slot, even before the background worker cancels it, so a
  // slow or sleeping worker can never keep a slot looking taken. Booking releases the row itself before it inserts.
  const nowMs = Date.now();
  const bookedRows = activeRows.filter(
    (row) => row.id !== options.ignoreAppointmentId && !(row.status === 'PENDING' && row.holdExpiresAt !== null && row.holdExpiresAt.getTime() <= nowMs),
  );

  const booked: BookedWindow[] = bookedRows.map((row) => ({ startTime: row.startTime, endTime: row.endTime, slotNumber: row.slotNumber }));

  const override: DateOverride | null = overrideRow
    ? {
        isAvailable: overrideRow.isAvailable,
        startTime: overrideRow.startTime,
        endTime: overrideRow.endTime,
        capacity: overrideRow.capacity,
        reason: overrideRow.reason,
      }
    : null;

  const sessions = resolveDay(override, ruleRows.map(toRule), date, {
    consultationMinutes: doctor.consultationMinutes,
    defaultCapacity: doctor.defaultDailyCapacity,
  });
  const isPastDate = date < today.date;
  // For past dates every slot is in the past; for today, slots up to "now" are.
  const cutoff = isPastDate ? '23:59' : date === today.date ? today.time : null;
  const result = buildSlots(
    sessions,
    doctor.consultationMinutes,
    // Full windows, so a booking blocks every slot that overlaps it, not only the one with the same start.
    booked,
    cutoff,
    slotIntervalOf(doctor),
  );

  return {
    doctorId,
    date,
    consultationMinutes: doctor.consultationMinutes,
    slotIntervalMinutes: slotIntervalOf(doctor),
    /** The active appointments that day, with the seat each holds. Booking uses it to pick a free seat; it is not part of the public answer. */
    booked,
    unavailableReason: override && !override.isAvailable ? (override.reason ?? 'Not available on this date') : null,
    ...result,
  };
}
