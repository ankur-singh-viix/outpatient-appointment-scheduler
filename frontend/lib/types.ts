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

/** STREAM: one patient per slot. WAVE: several patients per slot, up to capacityPerSlot. */
export type SchedulingMode = 'STREAM' | 'WAVE';

export interface Slot {
  startTime: string;
  endTime: string;
  status: SlotStatus;
  /** How many patients the slot takes (1 for STREAM), how many hold it, and how many places are left. */
  capacityPerSlot?: number;
  booked?: number;
  remaining?: number;
  mode?: SchedulingMode;
  /** The availability row the slot comes from; null on a date exception. Matches SessionSummary.availabilityId. */
  availabilityId?: string | null;
}

export interface SessionSummary {
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  remaining: number;
  source: 'OVERRIDE' | 'ONE_TIME' | 'WEEKLY';
  availabilityId?: string | null;
  mode?: SchedulingMode;
  /** Slot length for this session, which can differ from the doctor's default. */
  slotMinutes?: number;
  capacityPerSlot?: number;
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
  /** The doctor changed their hours and this booking no longer falls inside them. It is still booked until the patient moves it. */
  needsNewTime?: boolean;
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
  /** For a reminder: when it is (or was) due to go out. */
  sendAt: string;
  /** For a reminder: how many hours before the appointment it goes out (24, 1, ...). Null for everything else. */
  intervalHours: number | null;
  /** How it is delivered: by email, or as a text message (text reminders only). */
  channel: 'email' | 'sms';
  appointmentId: string;
  /** The appointment the message is about, for grouping and describing it. */
  appointment: { doctorName: string; date: string; startTime: string; endTime: string } | null;
}

/** How a patient is contacted. Essential appointment emails are not a choice: they are always sent. */
export interface NotificationPreferencesView {
  /** Also text essential updates (the email is sent regardless). */
  smsEnabled: boolean;
  emailReminders: boolean;
  smsReminders: boolean;
  promotionalEmail: boolean;
  promotionalSms: boolean;
  /** When the patient ticked each promotional box, or null while it is off. */
  promotionalEmailConsentAt: string | null;
  promotionalSmsConsentAt: string | null;
  /** Whether a text could reach this patient: a usable phone number on file, and an SMS service set up. */
  smsNumberOnFile: boolean;
  smsServiceAvailable: boolean;
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

/** What every availability row says: its hours, and how they are cut into slots. */
export interface AvailabilityRow {
  /** Absent on a row that has not been saved yet. */
  id?: string;
  startTime: string;
  endTime: string;
  /** STREAM only: the most bookings in the whole session. Null for WAVE, which limits each slot instead. */
  capacity: number | null;
  schedulingMode: SchedulingMode;
  /** Null follows the doctor's appointment length. */
  slotDurationMinutes: number | null;
  /** Always 1 for STREAM. */
  capacityPerSlot: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** Wave rows, from the server: the most patients in any upcoming slot, and the slots holding more than the capacity allows (null when none). */
  maxBooked?: number;
  overCapacity?: { slots: number; maxBooked: number } | null;
}

export interface WeeklyHours extends AvailabilityRow {
  dayOfWeek: number;
}

/** Hours for one date only. They take priority over the weekly hours for the time they overlap. */
export interface OneTimeSession extends AvailabilityRow {
  date: string;
}

export interface DateOverride {
  date: string;
  isAvailable: boolean;
  startTime: string | null;
  endTime: string | null;
  capacity: number | null;
  reason: string | null;
}

/** A receptionist account, as an administrator sees it. */
export interface AdminReceptionist {
  id: string;
  name: string;
  email: string;
  clinic: { id: string; name: string } | null;
  /** True until the receptionist has chosen their password from the emailed link. */
  invitePending: boolean;
}

/** What happened to an invitation email: a provider accepted it, it was only printed (development), or it was not sent. */
export interface InviteDelivery {
  status: 'sent' | 'logged' | 'failed';
  /** Why it failed, safe to show. */
  reason?: string;
}

/** How the server delivers email right now. `problem` says what is missing when it is off. */
export interface EmailStatus {
  mode: 'provider' | 'dev-log' | 'disabled';
  /** Resend's shared testing sender: it reaches only the Resend account owner's own address. */
  testingSender: boolean;
  problem: string | null;
}

/** A doctor at one of the receptionist's clinics. */
export interface ReceptionDoctor {
  id: string;
  name: string;
  specialty: string;
  clinic: { name: string; address: string };
  consultationFee: number;
  consultationMinutes: number;
}

/** A registered patient, as found by a receptionist's search. */
export interface ReceptionPatient {
  id: string;
  name: string;
  email: string;
  phone: string | null;
}

/** An active appointment at the receptionist's clinics. slotNumber is the place held in a shared (Wave) slot. */
export interface ReceptionAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  slotNumber: number;
  slotCapacity: number;
  patient: { id: string; name: string; phone: string | null };
  doctor: { id: string; name: string };
}

/** What changing the hours of an existing session would do, as the server works it out from the same slot rules booking uses. */
export interface HoursChangePreview {
  row: { id: string; recurrence: 'WEEKLY' | 'ONE_TIME'; dayOfWeek: number | null; date: string | null; mode: SchedulingMode; slotMinutes: number | null; capacityPerSlot: number };
  current: { startTime: string; endTime: string };
  proposed: { startTime: string; endTime: string };
  /** Recurring sessions: the first date the new hours apply to. Earlier dates keep theirs. */
  applyFrom: string;
  splitsAtDate: boolean;
  kind: 'EXPAND' | 'SHRINK' | 'MIXED' | 'NONE';
  /** Why the change cannot be made, in plain language. Empty when it can. */
  problems: string[];
  /** Start times that keep the existing slot grid, offered when the wanted one does not. */
  suggestedStarts: string[];
  addedSlots: number;
  removedSlots: number;
  /** Dates (from today to the end of the booking window) where the slots change. `days` lists the first few. */
  affectedDates: number;
  days: { date: string; added: { startTime: string; endTime: string }[]; removed: { startTime: string; endTime: string }[] }[];
  /** Booked appointments the new hours would leave outside them. They stay booked; each patient is asked to choose a new time. */
  affectedAppointments: AffectedAppointment[];
  affectedCount: number;
  /** Extending: booked appointments that were outside the hours and would be inside them again (the first few). They need nothing more. */
  restoredAppointments: Omit<AffectedAppointment, 'alternatives'>[];
  /** How many in all. */
  restoredCount: number;
  /** How many of them have no other open time to move to. */
  withoutAlternatives: number;
  canApply: boolean;
}

/** A time that is still open for booking, with the places left in it. */
export interface OpenTime {
  date: string;
  startTime: string;
  endTime: string;
  remaining: number;
}

/** A booked appointment that is outside the doctor's hours, with the open times it could move to. */
export interface AffectedAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  slotNumber: number;
  patient: { name: string; phone: string | null };
  alternatives: OpenTime[];
}

/** An appointment outside the doctor's current hours, and whether the patient has been asked to choose a new time. */
export interface OutsideHoursAppointment extends AffectedAppointment {
  asked: { at: string; status: string } | null;
  /** The change is recorded but the background job has not asked this patient yet. */
  noticePending: boolean;
  followUp: FollowUp;
}

/** Where an unresolved patient stands, so the doctor knows who needs a personal follow-up. */
export interface FollowUp {
  state: 'NOT_ASKED' | 'WAITING' | 'NO_RESPONSE' | 'NO_ALTERNATIVES';
  /** Automatic reminders sent after the first message (at most two). */
  reminders: number;
  lastContactAt: string | null;
}

/** What needs the doctor's attention (dashboard). */
export interface AttentionSummary {
  needsNewTime: number;
  noResponse: number;
  noAlternatives: number;
}

/** One page of appointments outside the doctor's hours; `nextCursor` asks for the following page. */
export interface OutsideHoursPage {
  appointments: OutsideHoursAppointment[];
  nextCursor: string | null;
}

/** A recent change of the doctor's hours and how its affected (or released) appointments stand. */
export interface ScheduleChangeSummary {
  id: string;
  kind: 'EXPAND' | 'SHRINK' | 'MIXED';
  applyFrom: string;
  oldStart: string;
  oldEnd: string;
  newStart: string;
  newEnd: string;
  affected: number;
  unresolved: number;
  rescheduled: number;
  cancelled: number;
  /** Appointments waiting for a new time that this change brought back inside the hours. */
  restored: number;
  createdAt: string;
}

/** Other open times a patient can move their own appointment to. */
export interface AppointmentAlternatives {
  appointmentId: string;
  doctorId: string;
  needsNewTime: boolean;
  alternatives: OpenTime[];
  /** Pass back as `cursor` for the next page of later times; null when there is no more. */
  nextCursor: string | null;
  searchedUntil: string;
}

/** A date that has sessions, with how much room is left on it (the calendar). A date with no sessions is not listed. */
export interface OpenDay {
  date: string;
  open: number;
  places: number;
}

/** One working session on a date, with every slot cut from it. */
export interface UpcomingSession {
  availabilityId: string | null;
  source: 'OVERRIDE' | 'ONE_TIME' | 'WEEKLY';
  mode: SchedulingMode;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  capacityPerSlot: number;
  /** STREAM: the session cap; WAVE: every place the session offers. */
  capacity: number;
  booked: number;
  remaining: number;
  slots: Slot[];
}

/** One date of the doctor's upcoming schedule. */
export interface UpcomingDay {
  date: string;
  unavailableReason: string | null;
  /** The date exception, if any: a day off, a blocked time, or replacement hours. */
  exception: { isAvailable: boolean; startTime: string | null; endTime: string | null; reason: string | null } | null;
  sessions: UpcomingSession[];
}

export interface UpcomingSchedule {
  days: UpcomingDay[];
}

export interface DoctorAvailability {
  consultationMinutes: number;
  /** Minutes between the starts of slots (equals consultationMinutes unless the doctor chose a shorter interval). */
  slotIntervalMinutes: number;
  /** True when the doctor chose their own interval; false while it simply follows the visit length. */
  slotIntervalCustom: boolean;
  defaultCapacity: number;
  /** What a new Wave session starts with: what the doctor already uses most, else the clinic default. */
  suggestedCapacityPerSlot: number;
  weekly: WeeklyHours[];
  oneTime: OneTimeSession[];
  overrides: DateOverride[];
}

/** The assistant's answer to one message: the text, and which lookups it used to produce it. */
export interface AssistantReply {
  reply: string;
  toolsUsed: string[];
  /** A confirmation card for the patient to press, when the assistant prepared a booking, move or cancellation. Written by the server. */
  actions?: ActionCard[];
  /** The saved conversation this exchange was added to. Missing when history could not be saved (the reply is still good). */
  conversationId?: string;
}

/** One saved conversation in the history list. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** One saved message. It holds text only: a reply that had a confirmation card has `hadCard`, and the card itself is gone. */
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolNames: string[];
  hadCard: boolean;
  createdAt: string;
}

/** A booking, move or cancellation waiting for the patient's Confirm. Nothing has happened yet. */
export interface ActionCard {
  /** Sent back, alone, to confirm or dismiss it. It works only for this patient, once, before it expires. */
  ref: string;
  /**
   * The doctor's kinds (SCHEDULE_CHANGE, DOCTOR_CANCEL, DOCTOR_RESCHEDULE, ADD_HOURS, BLOCK_DAY) carry a signed token as `ref`, confirmed
   * at /assistant/schedule-changes/confirm or /assistant/doctor-actions/confirm; the patient's three are stored rows.
   */
  kind: 'BOOK' | 'RESCHEDULE' | 'CANCEL' | 'SCHEDULE_CHANGE' | 'DOCTOR_CANCEL' | 'DOCTOR_RESCHEDULE' | 'ADD_HOURS' | 'BLOCK_DAY';
  title: string;
  lines: { label: string; value: string }[];
  note?: string;
  confirmLabel: string;
  dismissLabel: string;
  expiresAt: string;
}

/**
 * Where a prepared action really stands, from the appointment data. UNCERTAIN means the records cannot settle it: nothing was repeated,
 * and My Appointments shows the truth. NOT_APPLIED means the records show it did not happen.
 */
export interface ActionStatus {
  ref: string;
  kind: ActionCard['kind'];
  state: 'PREPARED' | 'IN_PROGRESS' | 'DONE' | 'NOT_APPLIED' | 'FAILED' | 'DISMISSED' | 'EXPIRED' | 'UNCERTAIN';
  message: string;
  appointment?: PatientAppointment;
  reconcileWith?: string;
}

/** What the server did when a card was confirmed, in its own words. A held booking carries the checkout for the existing secure payment. */
export interface ActionResult {
  kind: ActionCard['kind'];
  outcome: 'DONE' | 'PAYMENT_REQUIRED';
  message: string;
  appointment: PatientAppointment;
  checkout?: CheckoutDetails;
}
