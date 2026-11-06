import { Between, type EntityManager } from 'typeorm';
import { Availability, Doctor, ScheduleOverride, slotIntervalOf } from '../database/entities/index.js';
import { toRule } from './day-schedule.js';
import { isCovered, slotsOn, type Placed } from './elastic.js';
import { hhmm, type DateOverride, type Session } from './slots.js';

export const toOverride = (row: ScheduleOverride): DateOverride => ({
  isAvailable: row.isAvailable,
  startTime: row.startTime,
  endTime: row.endTime,
  capacity: row.capacity,
  reason: row.reason,
});

/**
 * The ids of the appointments that no longer fall inside the doctor's working hours, for the hours as they are right now (rows,
 * date exceptions and all). That happens when hours were reduced, or a day was taken off, while patients had booked. Such an
 * appointment is still booked and still valid; it just needs the patient to choose a new time.
 */
export async function appointmentsOutsideHours(manager: EntityManager, doctorId: string, appointments: Placed[]): Promise<Set<string>> {
  const outside = new Set<string>();
  if (appointments.length === 0) return outside;
  const doctor = await manager.findOneBy(Doctor, { id: doctorId });
  if (!doctor) return outside;
  const dates = appointments.map((appointment) => appointment.date).sort();
  const rules = (await manager.findBy(Availability, { doctorId })).map(toRule);
  const overrides = new Map((await manager.find(ScheduleOverride, { where: { doctorId, overrideDate: Between(dates[0], dates[dates.length - 1]) } })).map((row) => [row.overrideDate, toOverride(row)]));
  const elastic = { consultationMinutes: doctor.consultationMinutes, defaultCapacity: doctor.defaultDailyCapacity, slotIntervalMinutes: slotIntervalOf(doctor) };
  const sessions = new Map<string, Session[]>();
  for (const appointment of appointments) {
    let day = sessions.get(appointment.date);
    if (!day) {
      day = slotsOn(appointment.date, rules, overrides.get(appointment.date) ?? null, elastic).sessions;
      sessions.set(appointment.date, day);
    }
    if (!isCovered(day, hhmm(appointment.startTime), hhmm(appointment.endTime))) outside.add(appointment.id);
  }
  return outside;
}
