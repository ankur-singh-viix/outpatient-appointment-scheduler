import { ACTIVE_STATUSES, Appointment } from './appointment.entity.js';
import { Availability } from './availability.entity.js';
import { Clinic } from './clinic.entity.js';
import { Doctor, slotIntervalOf } from './doctor.entity.js';
import { EmailVerification } from './email-verification.entity.js';
import { ExternalIdentity } from './external-identity.entity.js';
import { Notification } from './notification.entity.js';
import { Patient } from './patient.entity.js';
import { PaymentEvent } from './payment-event.entity.js';
import { Payment } from './payment.entity.js';
import { Refund } from './refund.entity.js';
import { ReceptionistAssignment } from './receptionist-assignment.entity.js';
import { ScheduleOverride } from './schedule-override.entity.js';
import { Specialty } from './specialty.entity.js';
import { User } from './user.entity.js';

export {
  ACTIVE_STATUSES,
  Appointment,
  Availability,
  Clinic,
  Doctor,
  EmailVerification,
  ExternalIdentity,
  Notification,
  Patient,
  Payment,
  PaymentEvent,
  ReceptionistAssignment,
  Refund,
  slotIntervalOf,
  ScheduleOverride,
  Specialty,
  User,
};

/** The 9 tables from docs/er-diagram.md, plus email_verifications (pending sign-ups, see migration 003). */
export const ENTITIES = [
  User,
  Patient,
  Doctor,
  Clinic,
  Specialty,
  ReceptionistAssignment,
  Availability,
  ScheduleOverride,
  Appointment,
  EmailVerification,
  ExternalIdentity,
  Payment,
  Refund,
  PaymentEvent,
  Notification,
];
