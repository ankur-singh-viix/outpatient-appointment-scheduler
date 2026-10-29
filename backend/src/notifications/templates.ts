/** Everything a message needs to describe an appointment. */
export interface AppointmentFacts {
  patientName: string;
  doctorName: string;
  clinicName: string;
  clinicAddress: string;
  /** Clinic-local calendar date, YYYY-MM-DD. */
  date: string;
  /** Clinic-local start time, HH:MM. */
  startTime: string;
}

export interface MessageContent {
  kind: string;
  subject: string;
  body: string;
}

const rupees = (paise: number) => `Rs. ${(paise / 100).toFixed(2)}`;

function when(facts: Pick<AppointmentFacts, 'date' | 'startTime'>): string {
  const day = new Date(`${facts.date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const [hours, minutes] = facts.startTime.split(':').map(Number);
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  return `${day} at ${time}`;
}

const details = (facts: AppointmentFacts) =>
  `Doctor: ${facts.doctorName}\nWhen: ${when(facts)}\nWhere: ${facts.clinicName}, ${facts.clinicAddress}`;

export function bookingConfirmed(facts: AppointmentFacts): MessageContent {
  return {
    kind: 'booking-confirmed',
    subject: `Appointment confirmed: ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nYour appointment is confirmed.\n\n${details(facts)}\n\nYou can cancel or reschedule from your CareSlot dashboard.`,
  };
}

export function bookingRescheduled(facts: AppointmentFacts, previous: Pick<AppointmentFacts, 'date' | 'startTime'>): MessageContent {
  return {
    kind: 'booking-rescheduled',
    subject: `Appointment rescheduled: ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nYour appointment was moved from ${when(previous)}.\n\nNew time:\n${details(facts)}\n\nYour payment, if any, carries over to the new time.`,
  };
}

export function bookingCancelled(facts: AppointmentFacts, input: { cancelledBy: 'PATIENT' | 'DOCTOR' | 'SYSTEM'; reason: string; refundNote?: string }): MessageContent {
  const who =
    input.cancelledBy === 'DOCTOR' ? 'the doctor' : input.cancelledBy === 'SYSTEM' ? 'CareSlot, because payment was not completed in time' : 'you';
  return {
    kind: 'booking-cancelled',
    subject: `Appointment cancelled: ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nYour appointment was cancelled by ${who}.\nReason: ${input.reason}\n\n${details(facts)}${input.refundNote ? `\n\n${input.refundNote}` : ''}`,
  };
}

export function paymentReceived(facts: AppointmentFacts, input: { amountPaise: number; receipt: string }): MessageContent {
  return {
    kind: 'payment-received',
    subject: `Payment received: ${rupees(input.amountPaise)}`,
    body: `Hi ${facts.patientName},\n\nWe received your payment of ${rupees(input.amountPaise)}.\nReceipt: ${input.receipt}\n\n${details(facts)}`,
  };
}

export function refundUpdate(facts: AppointmentFacts, input: { amountPaise: number; status: 'PENDING' | 'PROCESSED' | 'FAILED'; reason: string }): MessageContent {
  const headline =
    input.status === 'PROCESSED'
      ? `Your refund of ${rupees(input.amountPaise)} has been processed. It can take 5-7 working days to reach your account.`
      : input.status === 'FAILED'
        ? `Your refund of ${rupees(input.amountPaise)} could not be completed. Our team will follow up.`
        : `Your refund of ${rupees(input.amountPaise)} has been started and is being processed.`;
  return {
    kind: `refund-${input.status.toLowerCase()}`,
    subject: `Refund ${input.status === 'PROCESSED' ? 'processed' : input.status === 'FAILED' ? 'failed' : 'started'}: ${rupees(input.amountPaise)}`,
    body: `Hi ${facts.patientName},\n\n${headline}\nReason: ${input.reason}\n\n${details(facts)}`,
  };
}

export function reminder(facts: AppointmentFacts, hoursBefore: number): MessageContent {
  const lead = hoursBefore >= 24 && hoursBefore % 24 === 0 ? `${hoursBefore / 24} day${hoursBefore === 24 ? '' : 's'}` : `${hoursBefore} hour${hoursBefore === 1 ? '' : 's'}`;
  return {
    kind: 'reminder',
    subject: `Reminder: appointment with ${facts.doctorName}, ${when(facts)}`,
    body: `Hi ${facts.patientName},\n\nThis is a reminder that your appointment is in about ${lead}.\n\n${details(facts)}`,
  };
}
