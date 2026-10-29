// Shapes returned by the backend API.

export type Role = 'PATIENT' | 'DOCTOR' | 'RECEPTIONIST' | 'ADMIN';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** Fetches a fresh token when called. Clerk session tokens are short-lived, so they are fetched per request, not stored. */
export type TokenGetter = () => Promise<string | null>;

export interface Session {
  /** A stored token (the legacy login) or a function that fetches a fresh one (Clerk). Pass it straight to api(). */
  accessToken: string | TokenGetter;
  user: PublicUser;
}

/** What the backend says about a Clerk sign-in: linked to a CareSlot account, or what is still needed. */
export type ClerkAccountStatus =
  | { state: 'LINKED'; user: PublicUser }
  | { state: 'ONBOARDING_REQUIRED'; email: string }
  | { state: 'LINK_REQUIRED'; email: string }
  | { state: 'CONFLICT'; email: string }
  | { state: 'EMAIL_UNVERIFIED' };

/** What signing in can return: a session, or a note that the sign-up still needs a role and profile. */
export type LoginResult = Session | { onboardingRequired: true; email: string; signupToken: string };

export interface Clinic {
  id: string;
  name: string;
  address: string;
}

export interface Specialty {
  id: string;
  name: string;
}

export interface WeeklyWindow {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface Doctor {
  id: string;
  name: string;
  bio: string | null;
  consultationFee: number;
  consultationMinutes: number;
  specialty: Specialty;
  clinic: { name: string; address: string };
  weeklyHours: WeeklyWindow[];
  /** The first slot a patient could book in the next two weeks, or null when none is free. */
  nextAvailable: { date: string; startTime: string; endTime: string } | null;
}

/** The signed-in doctor's own editable profile. */
export interface DoctorProfile {
  name: string;
  email: string;
  specialtyId: string;
  clinicId: string;
  consultationFee: number;
  consultationMinutes: number;
  bio: string | null;
}

export type SlotStatus = 'AVAILABLE' | 'BOOKED' | 'FULL' | 'PAST';

export interface Slot {
  startTime: string;
  endTime: string;
  status: SlotStatus;
}

export interface SessionSummary {
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  remaining: number;
  source: 'OVERRIDE' | 'WEEKLY';
}

export interface DaySchedule {
  doctorId: string;
  date: string;
  consultationMinutes: number;
  unavailableReason: string | null;
  sessions: SessionSummary[];
  slots: Slot[];
}

export type AppointmentStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

export interface PatientAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  /** Why it was cancelled, e.g. "Rescheduled by patient". Null for appointments that were not cancelled. */
  cancelReason: string | null;
  cancelledAt: string | null;
  /** Who cancelled it (the patient, or the doctor). Null while the appointment is active. */
  cancelledBy: Role | null;
  /** On an appointment created by a reschedule: the (cancelled) appointment it replaced. */
  rescheduledFromId: string | null;
  createdAt: string;
  doctor: { id: string; name: string; specialty: string; consultationFee: number };
  clinic: { name: string; address: string };
}

export interface DoctorAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledBy: Role | null;
  bookedAt: string;
  patient: { name: string; phone: string | null };
}

export interface WeeklyHours {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  capacity: number;
}

export interface DateOverride {
  date: string;
  isAvailable: boolean;
  startTime: string | null;
  endTime: string | null;
  capacity: number | null;
  reason: string | null;
}

export interface DoctorAvailability {
  consultationMinutes: number;
  defaultCapacity: number;
  weekly: WeeklyHours[];
  overrides: DateOverride[];
}
