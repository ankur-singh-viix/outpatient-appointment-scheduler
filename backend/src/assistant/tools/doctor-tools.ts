import { z } from 'zod';
import type { DataSource } from 'typeorm';
import { Doctor } from '../../database/entities/index.js';
import { AvailabilityChangeService } from '../../doctor-portal/availability-change.service.js';
import { DoctorPortalService } from '../../doctor-portal/doctor-portal.service.js';
import { DoctorsService } from '../../doctors/doctors.service.js';
import { addDays, dayOfWeek } from '../../scheduling/calendar.js';
import { DATE_PROPERTY, ToolInputError, calendarDate, defineTool, objectSchema, type AssistantTool } from './tool-types.js';
import { DAY_NAMES, clip, doctorAppointmentView, isActiveStatus } from './format.js';

const MAX_STATS_DAYS = 366;

export interface DoctorToolDeps {
  portal: DoctorPortalService;
  changes: AvailabilityChangeService;
  doctors: DoctorsService;
  dataSource: DataSource;
}

/**
 * The doctor assistant's tools. All read-only, and all about the signed-in doctor: the doctor is found from the verified user inside
 * the existing services (or, for the public directory, from the user's own account), never from anything the model or the person typed.
 */
export function doctorTools(deps: DoctorToolDeps): AssistantTool[] {
  return [
    defineTool({
      name: 'get_appointments_on_date',
      description:
        "Lists the signed-in doctor's own appointments on one date (today when no date is given): time, status (CONFIRMED, PENDING = awaiting payment, CANCELLED, COMPLETED, NO_SHOW) and the patient's name.",
      parameters: objectSchema({ date: { ...DATE_PROPERTY, description: 'The date as YYYY-MM-DD. Leave out for today.' } }),
      input: z.object({ date: calendarDate.optional() }),
      run: async (context, input) => {
        const date = input.date ?? context.today;
        const rows = await deps.portal.appointments(context.user, 'all', date);
        const byStatus: Record<string, number> = {};
        for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
        return {
          date,
          weekday: DAY_NAMES[dayOfWeek(date)],
          isToday: date === context.today,
          total: rows.length,
          active: rows.filter((row) => isActiveStatus(row.status)).length,
          byStatus,
          appointments: clip(rows.map(doctorAppointmentView)),
        };
      },
    }),

    defineTool({
      name: 'get_appointment_statistics',
      description:
        "Counts the signed-in doctor's appointments between two dates (inclusive) by status, and names the busiest day. Defaults to the last 30 days up to today.",
      parameters: objectSchema({ from: { ...DATE_PROPERTY, description: 'First date, YYYY-MM-DD.' }, to: { ...DATE_PROPERTY, description: 'Last date, YYYY-MM-DD.' } }),
      input: z.object({ from: calendarDate.optional(), to: calendarDate.optional() }),
      run: async (context, input) => {
        const to = input.to ?? context.today;
        const from = input.from ?? addDays(to, -29);
        if (to < from) throw new ToolInputError('"to" must not be before "from".');
        if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 >= MAX_STATS_DAYS) throw new ToolInputError(`The range can be at most ${MAX_STATS_DAYS} days.`);
        return deps.portal.appointmentStatistics(context.user, from, to);
      },
    }),

    defineTool({
      name: 'get_working_hours',
      description:
        "The signed-in doctor's availability PATTERN: weekly sessions (by weekday), one-time sessions, date exceptions (days off or changed hours), appointment length and how many patients each slot takes. It cannot say what one particular date holds (a recurring session may not have started yet, or an exception may cancel it): for a date, use get_slots_on_date.",
      parameters: objectSchema(),
      input: z.object({}),
      run: async (context) => {
        const availability = await deps.portal.availability(context.user);
        const settings = (row: { schedulingMode: string; slotDurationMinutes: number | null; capacityPerSlot: number; capacity: number | null }) => ({
          mode: row.schedulingMode === 'WAVE' ? 'WAVE (several patients share a slot)' : 'STREAM (one patient per slot)',
          slotMinutes: row.slotDurationMinutes ?? availability.consultationMinutes,
          ...(row.schedulingMode === 'WAVE' ? { patientsPerSlot: row.capacityPerSlot } : { sessionBookingCap: row.capacity }),
        });
        return {
          appointmentMinutes: availability.consultationMinutes,
          newSlotEveryMinutes: availability.slotIntervalMinutes,
          weekly: availability.weekly.map((row) => ({
            day: (row.dayOfWeek === null ? 'Weekly' : DAY_NAMES[row.dayOfWeek]),
            startTime: row.startTime,
            endTime: row.endTime,
            ...settings(row),
            ...(row.effectiveFrom ? { from: row.effectiveFrom } : {}),
            ...(row.effectiveTo ? { until: row.effectiveTo } : {}),
          })),
          oneTime: clip(availability.oneTime.map((row) => ({ date: row.date, startTime: row.startTime, endTime: row.endTime, ...settings(row) }))),
          exceptions: clip(
            availability.overrides.map((row) => ({
              date: row.date,
              available: row.isAvailable,
              ...(row.startTime ? { startTime: row.startTime, endTime: row.endTime } : {}),
              ...(row.reason ? { reason: row.reason } : {}),
            })),
          ),
        };
      },
    }),

    defineTool({
      name: 'get_slots_on_date',
      description:
        "The signed-in doctor's own schedule for ONE date, the way patients are booked and the dashboard shows it: the weekday (worked out for you: never work out a weekday yourself), whether the doctor works that day (recurring sessions, one-time sessions and date exceptions such as a day off are all applied), every slot with how many places are booked and left, and which slots can still be booked. Use it for 'my available slots on <date>', 'am I working on <date>', 'how full is <date>'.",
      parameters: objectSchema({ date: { ...DATE_PROPERTY, description: 'The date as YYYY-MM-DD.' } }, ['date']),
      input: z.object({ date: calendarDate }),
      run: async (context, input) => {
        const doctor = await deps.dataSource.getRepository(Doctor).findOne({ where: { userId: context.user.id }, select: { id: true } });
        if (!doctor) return { error: 'No doctor profile is linked to this account.' };
        // The same slot engine that books patients and fills the dashboard's schedule: one answer, however it is asked.
        const day = await deps.doctors.slots(doctor.id, input.date, false);
        const slots = day.slots.map((slot) => ({
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: slot.status,
          booked: slot.booked ?? 0,
          placesLeft: slot.remaining ?? (slot.status === 'AVAILABLE' ? 1 : 0),
          bookable: slot.status === 'AVAILABLE',
        }));
        const available = slots.filter((slot) => slot.bookable);
        const working = day.sessions.length > 0;
        return {
          date: input.date,
          weekday: DAY_NAMES[dayOfWeek(input.date)],
          working,
          ...(day.unavailableReason ? { reason: day.unavailableReason } : {}),
          ...(!working && !day.unavailableReason ? { note: 'No session is set for this date: weekly sessions, one-time sessions and date exceptions were all checked.' } : {}),
          sessions: day.sessions.map((session) => ({
            startTime: session.startTime,
            endTime: session.endTime,
            mode: session.mode === 'WAVE' ? 'WAVE (several patients share a slot)' : 'STREAM (one patient per slot)',
            slotMinutes: session.slotMinutes ?? day.consultationMinutes,
            ...(session.mode === 'WAVE' ? { patientsPerSlot: session.capacityPerSlot } : {}),
          })),
          availableCount: available.length,
          availableSlots: clip(available, 48).items,
          slots: clip(slots, 48).items,
          note: slots.length > 0 ? 'status: AVAILABLE can be booked; BOOKED means every place in the slot is taken; FULL means the session has reached its booking cap; PAST means the time has gone.' : undefined,
        };
      },
    }),

    defineTool({
      name: 'find_scheduling_conflicts',
      description:
        "Finds scheduling conflicts in the signed-in doctor's schedule: booked appointments that fall outside the current working hours (and whether the patient was asked to choose a new time), and slots holding more patients than their capacity now allows. Two patients can never hold the same place, so double booking is not a possible conflict.",
      parameters: objectSchema(),
      input: z.object({}),
      run: async (context) => {
        const [outside, availability, waiting] = await Promise.all([
          deps.changes.outsideHours(context.user, { limit: 20 }),
          deps.portal.availability(context.user),
          deps.changes.attention(context.user),
        ]);
        const over = [
          ...availability.weekly.map((row) => ({ label: `${(row.dayOfWeek === null ? 'Weekly' : DAY_NAMES[row.dayOfWeek])} ${row.startTime}-${row.endTime}`, over: row.overCapacity, perSlot: row.capacityPerSlot })),
          ...availability.oneTime.map((row) => ({ label: `${row.date} ${row.startTime}-${row.endTime}`, over: row.overCapacity, perSlot: row.capacityPerSlot })),
        ].filter((row) => row.over);
        return {
          outsideWorkingHours: {
            shown: outside.appointments.length,
            moreNotShown: outside.nextCursor !== null,
            appointments: outside.appointments.map((appointment) => ({
              ...doctorAppointmentView(appointment),
              patientStatus: appointment.followUp.state,
              remindersSent: appointment.followUp.reminders,
            })),
          },
          overCapacity: over.map((row) => ({ session: row.label, patientsPerSlot: row.perSlot, slotsOver: row.over?.slots, mostBooked: row.over?.maxBooked })),
          patientsStillNeedingANewTime: waiting.needsNewTime,
          noResponseAfterReminders: waiting.noResponse,
          noOtherTimeOpen: waiting.noAlternatives,
        };
      },
    }),

    defineTool({
      name: 'get_next_available_slot',
      description: "The next appointment slot that is still open in the signed-in doctor's own schedule, within the booking window.",
      parameters: objectSchema(),
      input: z.object({}),
      run: async (context) => {
        const doctor = await deps.dataSource.getRepository(Doctor).findOne({ where: { userId: context.user.id }, select: { id: true } });
        if (!doctor) return { error: 'No doctor profile is linked to this account.' };
        const found = await deps.doctors.get(doctor.id);
        return found.nextAvailable
          ? { nextAvailable: { date: found.nextAvailable.date, startTime: found.nextAvailable.startTime, endTime: found.nextAvailable.endTime } }
          : { nextAvailable: null, note: 'No open slot in the coming weeks.' };
      },
    }),
  ];
}
