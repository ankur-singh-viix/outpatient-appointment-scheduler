/**
 * What the model is allowed to see. Every tool builds its answer from these small, explicit shapes, never by passing a service result
 * through, so a new field added to an API later does not quietly reach the model. No phone numbers, email addresses, payment details,
 * internal ids of other people, or free-text reasons are included anywhere.
 */

/** The longest list any tool returns; the answer says how many there were in all. */
export const MAX_LIST = 30;

export function clip<T>(items: T[], max = MAX_LIST): { items: T[]; total: number; truncated: boolean } {
  return { items: items.slice(0, max), total: items.length, truncated: items.length > max };
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ACTIVE = new Set(['PENDING', 'CONFIRMED']);
export const isActiveStatus = (status: string): boolean => ACTIVE.has(status);

/** An appointment the way the doctor assistant sees it: when, its status, and the patient's name. Nothing else about the patient. */
export function doctorAppointmentView(row: { date: string; startTime: string; endTime: string; status: string; patient: { name: string } }) {
  return { date: row.date, startTime: row.startTime, endTime: row.endTime, status: row.status, patientName: row.patient.name };
}

/** An appointment the way the patient assistant sees it: the patient's own booking, with the doctor's public details. No payment data. */
export function patientAppointmentView(row: {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  needsNewTime?: boolean;
  doctor: { name: string; specialty: string };
  clinic: { name: string; address: string };
}) {
  return {
    appointmentId: row.id,
    doctorName: row.doctor.name,
    specialty: row.doctor.specialty,
    clinic: `${row.clinic.name}, ${row.clinic.address}`,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    status: row.status,
    ...(row.needsNewTime ? { needsNewTime: true } : {}),
  };
}

/** A doctor as patients see them in the public directory. */
export function publicDoctorView(row: {
  id: string;
  name: string;
  specialty: { name: string };
  clinic: { name: string; address: string };
  consultationFee: number;
  nextAvailable?: { date: string; startTime: string } | null;
}) {
  return {
    doctorId: row.id,
    name: row.name,
    specialty: row.specialty.name,
    clinic: `${row.clinic.name}, ${row.clinic.address}`,
    consultationFee: row.consultationFee,
    nextAvailable: row.nextAvailable ? { date: row.nextAvailable.date, startTime: row.nextAvailable.startTime } : null,
  };
}
