import { z } from 'zod';
import { AppointmentsService } from '../../appointments/appointments.service.js';
import { DoctorsService } from '../../doctors/doctors.service.js';
import { AssistantActionsService } from '../actions/assistant-actions.service.js';
import { rupees, type ActionCard } from '../actions/action-cards.js';
import { DATE_PROPERTY, ToolInputError, calendarDate, clockTime, defineTool, objectSchema, type AssistantTool, type ToolContext } from './tool-types.js';
import { clip, isActiveStatus, patientAppointmentView, publicDoctorView } from './format.js';

const MAX_DOCTORS = 10;
const MAX_SLOTS = 24;
const ALTERNATIVE_DAYS = 3;
const SLOTS_PER_DAY = 4;
/** How far ahead (in days) alternative dates are looked for around a requested date. */
const SEARCH_DAYS = 14;

export interface PatientToolDeps {
  appointments: AppointmentsService;
  doctors: DoctorsService;
  actions: AssistantActionsService;
}

const appointmentIdProperty = { type: 'string', description: "One of the patient's own appointmentIds (from get_my_appointments)." };
const TIME_PROPERTY = { type: 'string', description: 'The slot start time as HH:MM, 24-hour, exactly as listed by get_available_slots.' };

/** What each payment state means, in words the model must stick to, so it never claims more than the server has verified. */
const PAYMENT_MEANING: Record<string, string> = {
  PAYMENT_PENDING: 'The payment has NOT been completed. Do not say it is paid.',
  PAYMENT_FAILED: 'The last payment attempt failed. The slot is held only until the hold expires; the patient can retry from My Appointments.',
  EXPIRED: 'The payment window ended without payment, or the booking was cancelled.',
  PAID: 'The payment has been verified by the server.',
  REFUND_PENDING: 'The payment was verified. A refund has been started but is NOT complete until the payment provider confirms it.',
  PARTIALLY_REFUNDED: 'Part of the payment has been refunded (confirmed by the provider).',
  REFUNDED: 'The payment has been fully refunded (confirmed by the provider).',
};

/**
 * Only one action may be waiting on the patient's screen per answer, so the card they see is unambiguous. The check and the claim happen
 * with no await in between, so two calls in the same round cannot both get through.
 */
async function prepareOne(context: ToolContext, make: () => Promise<{ card: ActionCard; forModel: Record<string, unknown> }>) {
  if (context.cards.length > 0 || context.preparing) return { error: 'One confirmation card is already waiting for the patient. Ask them to confirm or cancel it before preparing another.' };
  context.preparing = true;
  try {
    const prepared = await make();
    context.cards.push(prepared.card);
    return prepared.forModel;
  } finally {
    context.preparing = false;
  }
}

const doctorIdProperty = { type: 'string', description: 'A doctorId returned by search_doctors.' };

/**
 * The patient assistant's tools. All read-only. A patient's own appointments are found from the verified user inside the existing
 * service, and an appointment id the model passes is checked against that user by the same service, so another patient's appointment
 * is just "not found". A doctorId only selects a public directory entry (the same open data the booking pages show).
 */
export function patientTools(deps: PatientToolDeps): AssistantTool[] {
  return [
    defineTool({
      name: 'get_my_appointments',
      description:
        "Lists the signed-in patient's own appointments: 'upcoming' (not yet finished, still booked), 'previous' (finished, cancelled or completed) or 'all'. Each has the doctor, clinic, date, time and status (CONFIRMED, PENDING = awaiting payment, CANCELLED, COMPLETED, NO_SHOW).",
      parameters: objectSchema({
        scope: { type: 'string', enum: ['upcoming', 'previous', 'all'], description: 'Which appointments. Defaults to upcoming.' },
        limit: { type: 'integer', description: 'How many to return, 1 to 20. Defaults to 10.' },
      }),
      input: z.object({ scope: z.enum(['upcoming', 'previous', 'all']).optional(), limit: z.number().int().min(1).max(20).optional() }),
      run: async (context, input) => {
        const scope = input.scope ?? 'upcoming';
        const rows = await deps.appointments.listForPatient(context.user);
        const upcoming = (row: (typeof rows)[number]) => isActiveStatus(row.status) && (row.date > context.today || (row.date === context.today && row.endTime > context.time));
        const chosen =
          scope === 'upcoming'
            ? rows.filter(upcoming).sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
            : scope === 'previous'
              ? rows.filter((row) => !upcoming(row)) // listForPatient is newest first, which is what "previous" wants
              : rows;
        const shown = clip(chosen.map(patientAppointmentView), input.limit ?? 10);
        return { scope, ...shown };
      },
    }),

    defineTool({
      name: 'search_doctors',
      description: "Searches the clinic's doctors by name or specialization (for example 'cardio' or 'Dr Rao'). Returns each doctor's id, specialty, clinic, fee and next available time. Without a query it lists doctors alphabetically.",
      parameters: objectSchema({ query: { type: 'string', description: 'Part of a doctor name or a specialization.' } }),
      input: z.object({ query: z.string().trim().max(80).optional() }),
      run: async (_context, input) => {
        const found = await deps.doctors.list(input.query || undefined);
        const shown = clip(found.map(publicDoctorView), MAX_DOCTORS);
        return { query: input.query ?? null, doctors: shown.items, total: shown.total, truncated: shown.truncated };
      },
    }),

    defineTool({
      name: 'get_available_slots',
      description: 'Lists the appointment slots that can still be booked with one doctor on one date, with how many places are left. Booking itself is not possible here.',
      parameters: objectSchema({ doctorId: doctorIdProperty, date: DATE_PROPERTY }, ['doctorId', 'date']),
      input: z.object({ doctorId: z.uuid(), date: calendarDate }),
      run: async (_context, input) => {
        const day = await deps.doctors.slots(input.doctorId, input.date, true);
        const slots = clip(
          day.slots.map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime, placesLeft: slot.remaining ?? 1 })),
          MAX_SLOTS,
        );
        return { doctorId: input.doctorId, date: input.date, unavailableReason: day.unavailableReason, availableSlots: slots.items, total: slots.total, truncated: slots.truncated };
      },
    }),

    defineTool({
      name: 'suggest_alternative_slots',
      description:
        "Suggests other times that are open. Give appointmentId (from get_my_appointments) for times the patient could move that appointment to, nearest first; or give doctorId and a preferred date to find the nearest other dates with open slots.",
      parameters: objectSchema({
        appointmentId: { type: 'string', description: "One of the patient's own appointmentIds." },
        doctorId: doctorIdProperty,
        date: { ...DATE_PROPERTY, description: 'The preferred date, YYYY-MM-DD. Defaults to today.' },
      }),
      input: z.object({ appointmentId: z.uuid().optional(), doctorId: z.uuid().optional(), date: calendarDate.optional() }),
      run: async (context, input) => {
        if (input.appointmentId) {
          const result = await deps.appointments.alternativesFor(context.user, input.appointmentId, { limit: 6 });
          return {
            appointmentId: input.appointmentId,
            needsNewTime: result.needsNewTime,
            alternatives: result.alternatives.map((slot) => ({ date: slot.date, startTime: slot.startTime, endTime: slot.endTime, placesLeft: slot.remaining })),
            moreAvailable: result.nextCursor !== null,
            note: result.alternatives.length === 0 ? 'No other time is open right now.' : undefined,
          };
        }
        if (!input.doctorId) throw new ToolInputError('Give either appointmentId, or doctorId (with an optional date).');
        const wanted = input.date ?? context.today;
        const { days } = await deps.doctors.openDays(input.doctorId, SEARCH_DAYS);
        const distance = (date: string) => Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${wanted}T00:00:00Z`));
        const nearest = days
          .filter((day) => day.open > 0 && day.date !== wanted)
          .sort((a, b) => distance(a.date) - distance(b.date) || a.date.localeCompare(b.date))
          .slice(0, ALTERNATIVE_DAYS)
          .sort((a, b) => a.date.localeCompare(b.date));
        const alternatives = [];
        for (const day of nearest) {
          const slots = (await deps.doctors.slots(input.doctorId, day.date, true)).slots.slice(0, SLOTS_PER_DAY);
          alternatives.push({ date: day.date, placesOpen: day.open, firstSlots: slots.map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime })) });
        }
        return { doctorId: input.doctorId, preferredDate: wanted, alternatives, note: alternatives.length === 0 ? `No other date in the next ${SEARCH_DAYS} days has an open slot.` : undefined };
      },
    }),

    // ------------------------------------------------------------------------------------------------------------------------------
    // Actions. These only PREPARE: each writes a confirmation card for the patient's screen and changes nothing. The change happens
    // when the patient presses Confirm, through a separate endpoint that this model cannot call.
    // ------------------------------------------------------------------------------------------------------------------------------
    defineTool({
      name: 'prepare_booking',
      description:
        'Prepares a booking for the patient to confirm. Use it only after the patient has clearly chosen one doctor (doctorId from search_doctors), one date and one start time from get_available_slots, and has asked to book it. It books nothing: it shows the patient a confirmation card.',
      parameters: objectSchema({ doctorId: doctorIdProperty, date: DATE_PROPERTY, startTime: TIME_PROPERTY }, ['doctorId', 'date', 'startTime']),
      input: z.object({ doctorId: z.uuid(), date: calendarDate, startTime: clockTime }),
      run: async (context, input) => {
        return prepareOne(context, () => deps.actions.prepareBooking(context.user, input));
      },
    }),

    defineTool({
      name: 'prepare_reschedule',
      description:
        "Prepares moving one of the patient's own appointments to another open slot of the same doctor, for the patient to confirm. Use it only after the patient has chosen the appointment and the new date and time (from suggest_alternative_slots or get_available_slots). It moves nothing: it shows a confirmation card.",
      parameters: objectSchema({ appointmentId: appointmentIdProperty, date: DATE_PROPERTY, startTime: TIME_PROPERTY }, ['appointmentId', 'date', 'startTime']),
      input: z.object({ appointmentId: z.uuid(), date: calendarDate, startTime: clockTime }),
      run: async (context, input) => {
        return prepareOne(context, () => deps.actions.prepareReschedule(context.user, input));
      },
    }),

    defineTool({
      name: 'prepare_cancellation',
      description:
        "Prepares cancelling one of the patient's own upcoming appointments, for the patient to confirm. Use it only when the patient has clearly asked to cancel that appointment. It cancels nothing: it shows a confirmation card with the refund the clinic policy would give.",
      parameters: objectSchema({ appointmentId: appointmentIdProperty }, ['appointmentId']),
      input: z.object({ appointmentId: z.uuid() }),
      run: async (context, input) => {
        return prepareOne(context, () => deps.actions.prepareCancellation(context.user, input));
      },
    }),

    defineTool({
      name: 'get_payment_status',
      description: "The payment state of one of the patient's own appointments, as recorded by the server after verification. Never guess a payment state: ask this.",
      parameters: objectSchema({ appointmentId: appointmentIdProperty }, ['appointmentId']),
      input: z.object({ appointmentId: z.uuid() }),
      run: async (context, input) => {
        const row = (await deps.appointments.listForPatient(context.user)).find((appointment) => appointment.id === input.appointmentId);
        if (!row) return { error: 'Appointment not found.' };
        const payment = row.payment;
        return {
          appointment: { doctorName: row.doctor.name, date: row.date, startTime: row.startTime, status: row.status },
          ...(row.status === 'PENDING' && row.holdExpiresAt ? { slotHeldUntil: row.holdExpiresAt } : {}),
          payment: payment
            ? {
                state: payment.displayStatus,
                meaning: PAYMENT_MEANING[payment.displayStatus] ?? 'Unknown state.',
                amount: rupees(payment.amountPaise),
                ...(payment.displayStatus === 'PAYMENT_FAILED' && payment.failureReason ? { failureReason: payment.failureReason } : {}),
              }
            : null,
          note: payment ? undefined : 'No payment is recorded for this appointment (it was free, or payment is not required).',
        };
      },
    }),

    defineTool({
      name: 'get_refund_status',
      description: "The refunds, if any, on one of the patient's own appointments, with their real status. A refund is complete only when its status is PROCESSED.",
      parameters: objectSchema({ appointmentId: appointmentIdProperty }, ['appointmentId']),
      input: z.object({ appointmentId: z.uuid() }),
      run: async (context, input) => {
        const row = (await deps.appointments.listForPatient(context.user)).find((appointment) => appointment.id === input.appointmentId);
        if (!row) return { error: 'Appointment not found.' };
        const payment = row.payment;
        if (!payment) return { appointment: { doctorName: row.doctor.name, date: row.date, status: row.status }, refunds: [], note: 'Nothing was paid for this appointment, so there is nothing to refund.' };
        return {
          appointment: { doctorName: row.doctor.name, date: row.date, status: row.status },
          paymentState: payment.displayStatus,
          refunds: payment.refunds.map((refund) => ({
            amount: rupees(refund.amountPaise),
            status: refund.status,
            meaning: refund.status === 'PROCESSED' ? 'Completed: the payment provider confirmed it.' : refund.status === 'PENDING' ? 'Started but NOT complete yet.' : 'It could not be completed yet; the clinic will follow up.',
            reason: refund.reason,
          })),
          note: payment.refunds.length === 0 ? 'No refund has been made or is due on this appointment.' : undefined,
        };
      },
    }),
  ];
}
