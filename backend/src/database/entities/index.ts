import { ACTIVE_STATUSES, Appointment } from './appointment.entity.js';
import { Availability } from './availability.entity.js';
import { Clinic } from './clinic.entity.js';
import { Doctor } from './doctor.entity.js';
import { EmailVerification } from './email-verification.entity.js';
import { Patient } from './patient.entity.js';
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
  Patient,
  ReceptionistAssignment,
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
];
