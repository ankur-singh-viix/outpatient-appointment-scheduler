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
  /** A new bookable slot starts this often. Shorter than the visit length means slots overlap (30-minute visits every 15 minutes). */
  slotIntervalMinutes: number;
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
  slotIntervalMinutes: number;
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
  /** While the booking waits for payment: when the held slot is released. Null otherwise. */
  holdExpiresAt: string | null;
  /** Payment, receipt and refunds, or null when the visit was free. */
  payment: PaymentSummary | null;
  doctor: { id: string; name: string; specialty: string; consultationFee: number };
  clinic: { name: string; address: string };
}

export type PaymentDisplayStatus =
  | 'PAYMENT_PENDING'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'PAID'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export interface RefundSummary {
  id: string;
  amountPaise: number;
  /** PROCESSED only once the payment provider has confirmed it. */
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  reason: string;
  /** The provider's refund id, to quote to the bank. Null until the provider has accepted the refund. */
  reference: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface PaymentSummary {
  id: string;
  displayStatus: PaymentDisplayStatus;
  amountPaise: number;
  paidAt: string | null;
  /** The receipt number. Null until paid. */
  receiptNumber: string | null;
  orderId: string;
  failureReason: string | null;
  /** Money the provider has confirmed returning. */
  refundedPaise: number;
  refunds: RefundSummary[];
}

/** One row of the payment history. */
export interface PaymentHistoryItem extends PaymentSummary {
  /** When the payment was started. */
  createdAt: string;
  appointment: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    status: AppointmentStatus;
    doctorName: string;
    specialty: string;
    clinicName: string;
    clinicAddress: string;
  };
}

/** A message CareSlot sent the patient (or a reminder still to come). */
export interface NotificationItem {
  id: string;
  kind: string;
  subject: string;
  body: string;
  /** SENT: delivered. SCHEDULED: a reminder waiting for its time. QUEUED: due and about to go out. */
  status: 'SENT' | 'SCHEDULED' | 'QUEUED';
  at: string;
  appointmentId: string;
}

/** The signed-in patient's own details. Null fields are ones they never gave. */
export interface PatientProfile {
  name: string;
  email: string;
  memberSince: string;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  address: string | null;
}

/** What the browser needs to open Razorpay Checkout. Contains only the public key id. */
export interface CheckoutDetails {
  appointmentId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  keyId: string;
  expiresAt: string | null;
}

/** The answer to booking when payment is needed: the held appointment plus the checkout to open. */
export type HeldAppointment = PatientAppointment & { checkout: CheckoutDetails };

export interface PaymentsConfig {
  enabled: boolean;
  holdMinutes: number;
  refundPolicy: { fullRefundHoursBefore: number; partialRefundHoursBefore: number; partialRefundPercent: number };
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
  /** Minutes between the starts of slots (equals consultationMinutes unless the doctor chose a shorter interval). */
  slotIntervalMinutes: number;
  /** True when the doctor chose their own interval; false while it simply follows the visit length. */
  slotIntervalCustom: boolean;
  defaultCapacity: number;
  weekly: WeeklyHours[];
  overrides: DateOverride[];
}
