/** Everything a message needs to describe an appointment. Deliberately no medical information: who, when and where only. */
export interface AppointmentFacts {
  patientName: string;
  doctorName: string;
  clinicName: string;
  clinicAddress: string;
  /** Clinic-local calendar date, YYYY-MM-DD. */
  date: string;
  /** Clinic-local start time, HH:MM. */
  startTime: string;
  /** Clinic-local end time, HH:MM. Optional so older callers keep working; the message shows a range when it is known. */
  endTime?: string;
  /** The doctor's specialty, shown in the patient's confirmation when known. */
  specialty?: string;
}

export interface MessageContent {
  kind: string;
  subject: string;
  /** The email body. */
  body: string;
  /** The text-message version: a single short line (at most 160 characters). Only patients are texted. */
  sms: string;
}

/** Who a message is written for. The same event reads differently to the patient and to the doctor. */
export type Audience = 'patient' | 'doctor';

const rupees = (paise: number) => `Rs. ${(paise / 100).toFixed(2)}`;
const clip = (text: string, max = 160) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

function clock(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function when(facts: Pick<AppointmentFacts, 'date' | 'startTime' | 'endTime'>): string {
  const day = new Date(`${facts.date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${day} at ${facts.endTime ? `${clock(facts.startTime)} – ${clock(facts.endTime)}` : clock(facts.startTime)}`;
}

const details = (facts: AppointmentFacts) =>
  `Doctor: ${facts.doctorName}\n${facts.specialty ? `Specialty: ${facts.specialty}\n` : ''}When: ${when(facts)}\nWhere: ${facts.clinicName}, ${facts.clinicAddress}`;
const patientDetails = (facts: AppointmentFacts) =>
  `Patient: ${facts.patientName}\nWhen: ${when(facts)}\nWhere: ${facts.clinicName}, ${facts.clinicAddress}`;

export function bookingConfirmed(facts: AppointmentFacts, audience: Audience = 'patient'): MessageContent {
  if (audience === 'doctor') {
    return {
      kind: 'booking-confirmed',
      subject: `New booking: ${facts.patientName}, ${when(facts)}`,
      body: `Hello ${facts.doctorName},\n\nAn appointment has been booked with you.\n\n${patientDetails(facts)}`,
      sms: '',
    };
  }
  return {
    kind: 'booking-confirmed',
    subject: `Appointment confirmed: ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nYour appointment is confirmed. Your booking is complete and your place is reserved.\n\n${details(facts)}\n\nYou can cancel or reschedule from your CareSlot dashboard.`,
    sms: clip(`CareSlot: appointment confirmed with ${facts.doctorName}, ${when(facts)}.`),
  };
}

export function bookingRescheduled(facts: AppointmentFacts, previous: Pick<AppointmentFacts, 'date' | 'startTime' | 'endTime'>, audience: Audience = 'patient'): MessageContent {
  if (audience === 'doctor') {
    return {
      kind: 'booking-rescheduled',
      subject: `Booking rescheduled: ${facts.patientName}, ${when(facts)}`,
      body: `Hello ${facts.doctorName},\n\n${facts.patientName} moved their appointment from ${when(previous)}.\n\nNew time:\n${patientDetails(facts)}`,
      sms: '',
    };
  }
  return {
    kind: 'booking-rescheduled',
    subject: `Appointment rescheduled: ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nYour appointment was moved from ${when(previous)}.\n\nNew time:\n${details(facts)}\n\nYour payment, if any, carries over to the new time.`,
    sms: clip(`CareSlot: appointment with ${facts.doctorName} moved from ${when(previous)} to ${when(facts)}.`),
  };
}

export function bookingCancelled(
  facts: AppointmentFacts,
  input: { cancelledBy: 'PATIENT' | 'DOCTOR' | 'SYSTEM'; reason: string; refundNote?: string },
  audience: Audience = 'patient',
): MessageContent {
  if (audience === 'doctor') {
    const who = input.cancelledBy === 'DOCTOR' ? 'You cancelled' : input.cancelledBy === 'SYSTEM' ? 'CareSlot released' : `${facts.patientName} cancelled`;
    return {
      kind: 'booking-cancelled',
      subject: `Booking cancelled: ${facts.patientName}, ${when(facts)}`,
      body: `Hello ${facts.doctorName},\n\n${who} this appointment. The time is available to other patients again.\nReason: ${input.reason}\n\n${patientDetails(facts)}`,
      sms: '',
    };
  }
  const who =
    input.cancelledBy === 'DOCTOR' ? 'the doctor' : input.cancelledBy === 'SYSTEM' ? 'CareSlot, because payment was not completed in time' : 'you';
  return {
    kind: 'booking-cancelled',
    subject: `Appointment cancelled: ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nYour appointment was cancelled by ${who}.\nReason: ${input.reason}\n\n${details(facts)}${input.refundNote ? `\n\n${input.refundNote}` : ''}\n\nWhat you can do next: if you still need to be seen, book another time from your CareSlot dashboard. Your original appointment will not go ahead.`,
    sms: clip(`CareSlot: your appointment with ${facts.doctorName}, ${when(facts)}, was cancelled${input.cancelledBy === 'DOCTOR' ? ' by the doctor' : ''}.`),
  };
}

/**
 * The doctor's hours changed and this appointment no longer fits them. Nothing has been moved or cancelled: the booking stands until
 * the patient chooses a new time. `link` opens the existing reschedule page (the patient signs in there and confirms the move), and
 * `proposed` is a time the doctor suggests, if they picked one.
 */
export function needsNewTime(facts: AppointmentFacts, input: { link: string; proposed?: Pick<AppointmentFacts, 'date' | 'startTime' | 'endTime'> }): MessageContent {
  return {
    kind: 'needs-new-time',
    subject: `Please choose a new time: ${facts.doctorName}, ${when(facts)}`,
    body:
      `Hi ${facts.patientName},

${facts.doctorName} has changed their hours, and your appointment is no longer within them. ` +
      `Nothing has been cancelled or moved: your booking stays as it is until you choose a new time.

${details(facts)}

` +
      `${input.proposed ? `The doctor suggests: ${when(input.proposed)}

` : ''}Choose a new time here (you will be asked to confirm the move): ${input.link}

` +
      'If none of the available times suit you, you can cancel from your appointments page or contact the clinic.',
    sms: clip(`CareSlot: ${facts.doctorName} changed their hours; your ${when(facts)} appointment needs a new time. Choose one: ${input.link}`),
  };
}

/** The most automatic reminders a patient who has not chosen a new time gets, after the first message. */
export const MAX_NEW_TIME_REMINDERS = 2;

/** A reminder that the appointment still needs a new time. Calm and clear: nothing happens to the booking if the patient does nothing. */
export function needsNewTimeReminder(facts: AppointmentFacts, input: { link: string; number: number }): MessageContent {
  return {
    kind: 'needs-new-time-reminder',
    subject: `Reminder ${input.number} of ${MAX_NEW_TIME_REMINDERS}: please choose a new time, ${facts.doctorName}, ${when(facts)}`,
    body:
      `Hi ${facts.patientName},\n\n` +
      `This is a reminder that ${facts.doctorName} changed their hours and your appointment is no longer within them. Your booking is still in place and nothing has been cancelled or moved, but it needs a new time.\n\n` +
      `${details(facts)}\n\n` +
      `Choose a new time here (you will be asked to confirm the move): ${input.link}\n\n` +
      'If no available time suits you, you can contact the clinic or cancel from your appointments page.',
    sms: clip(`CareSlot: reminder ${input.number} of ${MAX_NEW_TIME_REMINDERS}. Your ${when(facts)} appointment with ${facts.doctorName} still needs a new time. Choose one: ${input.link}`),
  };
}

/** Sent once to a patient who had no other time to choose from, when suitable availability appears. */
export function newTimesAvailable(facts: AppointmentFacts, input: { link: string }): MessageContent {
  return {
    kind: 'new-times-available',
    subject: `New times are open for your appointment with ${facts.doctorName}`,
    body:
      `Hi ${facts.patientName},\n\n` +
      `Good news: ${facts.doctorName} now has times you can move your appointment to. Your current appointment is still booked, exactly as it was, and nothing has been reserved or changed for you.\n\n` +
      `${details(facts)}\n\n` +
      `See the open times and choose one (you will be asked to confirm): ${input.link}\n\n` +
      'Places are given to whoever confirms first, so choose soon if one of these suits you.',
    sms: clip(`CareSlot: new times are open with ${facts.doctorName} for your ${when(facts)} appointment. Choose one: ${input.link}`),
  };
}

/**
 * The patient was asked to choose a new time because the doctor's hours changed (see needsNewTime), and then the hours changed
 * back so the original appointment fits again. Only sent to a patient who actually received that request.
 */
export function appointmentRestored(facts: AppointmentFacts): MessageContent {
  return {
    kind: 'appointment-restored',
    subject: `No action needed: your appointment is valid again, ${facts.doctorName}, ${when(facts)}`,
    body:
      `Hi ${facts.patientName},\n\n` +
      `Earlier we asked you to choose a new time because ${facts.doctorName} changed their hours. Their hours have changed again, and your original appointment is valid again.\n\n` +
      `${details(facts)}\n\n` +
      'You do not need to do anything or reschedule: your appointment stays booked exactly as it was. If the time no longer suits you, you can still reschedule or cancel from your CareSlot dashboard.',
    sms: clip(`CareSlot: no action needed. Your ${when(facts)} appointment with ${facts.doctorName} is valid again.`),
  };
}

export function paymentReceived(facts: AppointmentFacts, input: { amountPaise: number; receipt: string }): MessageContent {
  return {
    kind: 'payment-received',
    subject: `Payment received: ${rupees(input.amountPaise)}`,
    body: `Hi ${facts.patientName},\n\nWe received your payment of ${rupees(input.amountPaise)}.\nReceipt: ${input.receipt}\n\n${details(facts)}`,
    sms: clip(`CareSlot: payment of ${rupees(input.amountPaise)} received for your appointment on ${when(facts)}. Receipt ${input.receipt}.`),
  };
}

/** The payment did not go through. The slot is still held, so the patient is told they can try again. */
export function paymentFailed(facts: AppointmentFacts, input: { reason?: string }): MessageContent {
  const reason = input.reason ? `\nReason given by the payment provider: ${input.reason}` : '';
  return {
    kind: 'payment-failed',
    subject: `Payment failed: ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nYour payment did not go through, so your appointment is not confirmed yet.${reason}\n\nYour slot is held for a short time. Open My Appointments in CareSlot to try the payment again before it is released.\n\n${details(facts)}`,
    sms: clip(`CareSlot: your payment for ${facts.doctorName}, ${when(facts)}, failed. Try again from My Appointments before the slot is released.`),
  };
}

export function refundUpdate(facts: AppointmentFacts, input: { amountPaise: number; status: 'PENDING' | 'PROCESSED' | 'FAILED'; reason: string }): MessageContent {
  const headline =
    input.status === 'PROCESSED'
      ? `Your refund of ${rupees(input.amountPaise)} has been processed. It can take 5-7 working days to reach your account.`
      : input.status === 'FAILED'
        ? `Your refund of ${rupees(input.amountPaise)} could not be completed. Our team will follow up.`
        : `Your refund of ${rupees(input.amountPaise)} has been started and is being processed.`;
  const sms =
    input.status === 'PROCESSED'
      ? `CareSlot: your refund of ${rupees(input.amountPaise)} has been processed. It can take 5-7 working days to arrive.`
      : input.status === 'FAILED'
        ? `CareSlot: your refund of ${rupees(input.amountPaise)} could not be completed. We will follow up.`
        : `CareSlot: your refund of ${rupees(input.amountPaise)} has been started.`;
  return {
    kind: `refund-${input.status.toLowerCase()}`,
    subject: `Refund ${input.status === 'PROCESSED' ? 'processed' : input.status === 'FAILED' ? 'failed' : 'started'}: ${rupees(input.amountPaise)}`,
    body: `Hi ${facts.patientName},\n\n${headline}\nReason: ${input.reason}\n\n${details(facts)}`,
    sms: clip(sms),
  };
}

/** "1 day", "2 hours", "30 minutes": how far away the appointment is, in the words a person would use. */
function leadText(hours: number): string {
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (hours >= 1) {
    const whole = Math.round(hours);
    return `${whole} hour${whole === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(hours * 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** `hoursBefore` is how far away the appointment is when the reminder goes out (it can be fractional). */
export function reminder(facts: AppointmentFacts, hoursBefore: number): MessageContent {
  const lead = leadText(hoursBefore);
  return {
    kind: 'reminder',
    subject: `Reminder: appointment with ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nThis is a reminder that your appointment is in about ${lead}.\n\n${details(facts)}`,
    sms: clip(`CareSlot reminder: appointment with ${facts.doctorName}, ${when(facts)}.`),
  };
}
