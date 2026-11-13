import { z } from 'zod';
import type { DataSource } from 'typeorm';
import { Doctor } from '../../database/entities/index.js';
import { AvailabilityChangeService } from '../../doctor-portal/availability-change.service.js';
import { DoctorPortalService } from '../../doctor-portal/doctor-portal.service.js';
import { DoctorsService } from '../../doctors/doctors.service.js';
import { addDays, dayOfWeek } from '../../scheduling/calendar.js';
import { DoctorActionsService, type DoctorPrepareOutcome } from '../actions/doctor-actions.service.js';
import { ScheduleChangeActionsService } from '../actions/schedule-change-actions.service.js';
import { DATE_PROPERTY, ToolInputError, calendarDate, clockTime, defineTool, objectSchema, type AssistantTool, type ToolContext } from './tool-types.js';
import { DAY_NAMES, clip, doctorAppointmentView, isActiveStatus } from './format.js';

const MAX_STATS_DAYS = 366;

export interface DoctorToolDeps {
  portal: DoctorPortalService;
  changes: AvailabilityChangeService;
  doctors: DoctorsService;
  dataSource: DataSource;
  scheduleChanges: ScheduleChangeActionsService;
  doctorActions: DoctorActionsService;
}

const PREPARED_NOTE =
  "A confirmation card is now on the doctor's screen showing exactly what will happen. Nothing has been done and nobody has been contacted. Never say it was done: only the doctor pressing Confirm on the card can do that, and a 'yes' in chat or by voice is not a confirmation.";

/**
 * The shared shape of the four doctor "prepare" tools: one card per answer (the check and the claim have no await between them, so two
 * calls in one round cannot both get through), and every outcome turned into a short note for the model. The card itself goes to the
 * doctor's screen with the reply and never passes through the model.
 */
async function prepareOne(context: ToolContext, make: () => Promise<DoctorPrepareOutcome>) {
  if (context.cards.length > 0 || context.preparing) return { error: 'A confirmation card is already waiting for the doctor. Ask them to confirm or cancel it before preparing another.' };
  context.preparing = true;
  try {
    const outcome = await make();
    if ('needsDecision' in outcome) {
      return {
        prepared: false,
        needsDecision: true,
        bookedAppointments: outcome.appointments,
        options: outcome.options,
        instruction: 'Tell the doctor how many appointments are booked that day, explain both options in a sentence each, and ask which they want. Do NOT choose for them. Then call this tool again with handlingOfBookedAppointments.',
      };
    }
    if (!outcome.prepared) return { prepared: false, cannotBePrepared: outcome.problems };
    context.cards.push(outcome.card);
    return { prepared: true, preview: outcome.summary, note: PREPARED_NOTE };
  } finally {
    context.preparing = false;
  }
}

const TIME_OF_DAY = { type: 'string', description: 'A time as HH:MM, 24-hour.' };
const PATIENT_NAME = { type: 'string', description: "Part of the patient's name, to tell two appointments at the same time apart." };

/**
 * The doctor assistant's tools. All about the signed-in doctor: the doctor is found from the verified user inside the existing
 * services (or, for the public directory, from the user's own account), never from anything the model or the person typed. They only
 * read, except prepare_schedule_change, which still changes nothing: it shows the doctor a confirmation card that only the doctor's
 * button press (a separate, signed request the model cannot make) can act on.
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
              // The "choose a new time" email: SENT, PENDING (still being delivered, retried automatically), FAILED (could not be delivered), or not yet sent.
              noticeEmail: appointment.asked?.status ?? (appointment.noticePending ? 'QUEUED' : 'NOT_SENT'),
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
      name: 'prepare_schedule_change',
      description:
        "PREPARES (does not apply) a change to the hours of one of the signed-in doctor's sessions, to shorten or extend it. It previews who is affected and shows the doctor a confirmation card; nothing changes, and no patient is contacted, until the doctor presses Confirm on that card. Name the session by weekday (a weekly session: the change applies from applyFrom onwards, default today) or by date (a one-time session on that date). Give the new start and end time as HH:MM. If the doctor has more than one session that day, also give currentStartTime. Use it only when the doctor clearly asks for a specific change; ask if the day or the new hours are unclear.",
      parameters: objectSchema(
        {
          weekday: { type: 'string', enum: DAY_NAMES, description: 'The weekday of a weekly session, e.g. Monday.' },
          date: { ...DATE_PROPERTY, description: 'The date of a ONE-TIME session (not for a weekly session).' },
          currentStartTime: { type: 'string', description: 'The session\'s current start time as HH:MM, only to tell two sessions on the same day apart.' },
          newStartTime: { type: 'string', description: 'The new start time as HH:MM, 24-hour.' },
          newEndTime: { type: 'string', description: 'The new end time as HH:MM, 24-hour.' },
          applyFrom: { ...DATE_PROPERTY, description: 'Weekly sessions only: the first date the new hours apply to. Defaults to today.' },
        },
        ['newStartTime', 'newEndTime'],
      ),
      input: z
        .object({
          weekday: z.enum(DAY_NAMES as [string, ...string[]]).optional(),
          date: calendarDate.optional(),
          currentStartTime: clockTime.optional(),
          newStartTime: clockTime,
          newEndTime: clockTime,
          applyFrom: calendarDate.optional(),
        })
        .refine((value) => (value.weekday === undefined) !== (value.date === undefined), { message: 'give either weekday (weekly session) or date (one-time session), not both and not neither' }),
      run: async (context, input) => {
        if (context.cards.length > 0 || context.preparing) return { error: 'A confirmation card is already waiting for the doctor. Ask them to confirm or cancel it before preparing another.' };
        context.preparing = true;
        try {
          const availability = await deps.portal.availability(context.user);
          const from = input.applyFrom ?? context.today;
          let rows: { id: string; startTime: string; endTime: string }[] = input.weekday
            ? availability.weekly.filter((row) => row.dayOfWeek === DAY_NAMES.indexOf(input.weekday as string) && (!row.effectiveTo || row.effectiveTo >= from))
            : availability.oneTime.filter((row) => row.date === input.date);
          if (input.currentStartTime) rows = rows.filter((row) => row.startTime === input.currentStartTime);
          if (rows.length === 0) {
            const weeklyThatDay = input.date ? availability.weekly.some((row) => row.dayOfWeek === dayOfWeek(input.date as string)) : false;
            return {
              error: weeklyThatDay
                ? `There is no one-time session on ${input.date}. That day belongs to a weekly session; changing it affects every such weekday from a start date. Ask the doctor whether they mean the weekly session, then use weekday.`
                : 'No matching session was found. Check get_working_hours for the sessions the doctor has.',
            };
          }
          if (rows.length > 1) return { error: 'More than one session matches. Ask the doctor which one, then pass currentStartTime.', sessions: rows.map((row) => ({ startTime: row.startTime, endTime: row.endTime })) };

          const prepared = await deps.scheduleChanges.prepare(context.user, {
            availabilityId: rows[0].id,
            startTime: input.newStartTime,
            endTime: input.newEndTime,
            applyFrom: input.weekday ? input.applyFrom : undefined,
          });
          if (!prepared.prepared) return { prepared: false, cannotBeApplied: prepared.problems };
          context.cards.push(prepared.card);
          return {
            prepared: true,
            preview: prepared.summary,
            note: 'A confirmation card is now on the doctor\'s screen listing every affected patient with alternative times. Nothing has been changed and nobody has been contacted. Never say the change was made: only the doctor pressing Confirm can do that.',
          };
        } finally {
          context.preparing = false;
        }
      },
    }),

    defineTool({
      name: 'prepare_cancel_appointment',
      description:
        "PREPARES (does not do) the cancellation of ONE of the signed-in doctor's own upcoming appointments, found by its date and time and/or the patient's name. It shows the doctor a confirmation card; nothing is cancelled and nobody is contacted until the doctor presses Confirm. The doctor must give a reason (the patient is told it): if they have not, ask for it first. If more than one appointment matches, ask which.",
      parameters: objectSchema(
        { date: { ...DATE_PROPERTY, description: "The appointment's date, YYYY-MM-DD." }, startTime: { ...TIME_OF_DAY, description: "The appointment's start time as HH:MM." }, patientName: PATIENT_NAME, reason: { type: 'string', description: 'Why it is being cancelled, in the doctor\'s own words (3 to 200 characters). The patient reads it.' } },
        ['date'],
      ),
      input: z.object({ date: calendarDate, startTime: clockTime.optional(), patientName: z.string().trim().min(1).max(100).optional(), reason: z.string().trim().max(200).optional() }),
      run: async (context, input) => {
        if (!input.reason || input.reason.length < 3) return { prepared: false, missing: ['reason'], instruction: 'Ask the doctor for the reason (at least 3 characters). The patient will be told it.' };
        const reason = input.reason;
        return prepareOne(context, () => deps.doctorActions.prepareCancel(context.user, { date: input.date, startTime: input.startTime, patientName: input.patientName, reason }));
      },
    }),

    defineTool({
      name: 'prepare_reschedule_appointment',
      description:
        "PREPARES (does not do) moving ONE of the signed-in doctor's own confirmed upcoming appointments to another open slot in their own schedule. The new slot is checked against the real availability. It shows the doctor a confirmation card; nothing moves and the patient is not contacted until the doctor presses Confirm. Find the appointment by date and time and/or the patient's name; if the doctor has not said the new date and time, ask. If the new slot is not open the answer says which times are.",
      parameters: objectSchema(
        {
          date: { ...DATE_PROPERTY, description: "The appointment's current date, YYYY-MM-DD." },
          startTime: { ...TIME_OF_DAY, description: "The appointment's current start time as HH:MM." },
          patientName: PATIENT_NAME,
          newDate: { ...DATE_PROPERTY, description: 'The new date, YYYY-MM-DD.' },
          newStartTime: { ...TIME_OF_DAY, description: 'The new start time as HH:MM.' },
        },
        ['date', 'newDate', 'newStartTime'],
      ),
      input: z.object({ date: calendarDate, startTime: clockTime.optional(), patientName: z.string().trim().min(1).max(100).optional(), newDate: calendarDate, newStartTime: clockTime }),
      run: async (context, input) => prepareOne(context, () => deps.doctorActions.prepareReschedule(context.user, input)),
    }),

    defineTool({
      name: 'prepare_add_working_hours',
      description:
        "PREPARES (does not do) adding a NEW working session for the signed-in doctor on one date (for example an extra evening session). It shows the doctor a confirmation card; nothing is added until the doctor presses Confirm. To make an EXISTING session longer or shorter use prepare_schedule_change instead. Ask for the date and the start and end time if the doctor has not given them.",
      parameters: objectSchema(
        {
          date: { ...DATE_PROPERTY, description: 'The date, YYYY-MM-DD.' },
          startTime: { ...TIME_OF_DAY, description: 'Start of the new session, HH:MM.' },
          endTime: { ...TIME_OF_DAY, description: 'End of the new session, HH:MM.' },
          patientsPerSlot: { type: 'integer', description: 'How many patients each slot takes. Leave out for one.' },
        },
        ['date', 'startTime', 'endTime'],
      ),
      input: z.object({ date: calendarDate, startTime: clockTime, endTime: clockTime, patientsPerSlot: z.number().int().min(1).max(100).optional() }),
      run: async (context, input) => prepareOne(context, () => deps.doctorActions.prepareAddHours(context.user, input)),
    }),

    defineTool({
      name: 'prepare_block_day',
      description:
        "PREPARES (does not do) marking one whole date as unavailable for the signed-in doctor, so patients cannot book it. It shows the doctor a confirmation card; nothing is blocked until the doctor presses Confirm. If appointments are already booked that day it does NOT go ahead: it returns the choices and you must ask the doctor how to handle them, then call again with handlingOfBookedAppointments: KEEP_AND_ASK_PATIENTS (they stay booked and each patient is emailed to choose a new time) or CANCEL_AND_REFUND (every appointment is cancelled with a reason, patients are emailed and refunded). Never pick one yourself.",
      parameters: objectSchema(
        {
          date: { ...DATE_PROPERTY, description: 'The date to block, YYYY-MM-DD.' },
          handlingOfBookedAppointments: { type: 'string', enum: ['KEEP_AND_ASK_PATIENTS', 'CANCEL_AND_REFUND'], description: 'Only after the doctor has chosen.' },
          cancelReason: { type: 'string', description: 'With CANCEL_AND_REFUND: why, as the patients are told (3 to 200 characters). Ask the doctor if they have not said.' },
          reason: { type: 'string', description: 'An optional note for the block itself.' },
        },
        ['date'],
      ),
      input: z.object({
        date: calendarDate,
        handlingOfBookedAppointments: z.enum(['KEEP_AND_ASK_PATIENTS', 'CANCEL_AND_REFUND']).optional(),
        cancelReason: z.string().trim().max(200).optional(),
        reason: z.string().trim().max(200).optional(),
      }),
      run: async (context, input) => {
        if (input.handlingOfBookedAppointments === 'CANCEL_AND_REFUND' && !input.cancelReason) {
          return { prepared: false, missing: ['cancelReason'], instruction: 'Ask the doctor why the appointments are being cancelled (at least 3 characters). The patients are told it.' };
        }
        const handling = input.handlingOfBookedAppointments === 'CANCEL_AND_REFUND' ? ('CANCEL' as const) : input.handlingOfBookedAppointments === 'KEEP_AND_ASK_PATIENTS' ? ('KEEP' as const) : undefined;
        return prepareOne(context, () => deps.doctorActions.prepareBlockDay(context.user, { date: input.date, handling, cancelReason: input.cancelReason, reason: input.reason }));
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
