import { z } from 'zod';
import { loadConfig } from '../config.js';
import { clinicNow } from '../scheduling/calendar.js';
import { dateSchema } from '../scheduling/schemas.js';

// The profile a new account fills in. Shared by the legacy sign-up and the Clerk sign-in so both enforce the same rules.
// Only PATIENT and DOCTOR exist here: a role is never taken from a token, from Clerk, or from anything but this form,
// and receptionist and admin accounts cannot be created through it at all.

// 50 characters each keeps "Dr. <first> <last>" inside the 120-character users.name column.
const nameSchema = z.string().trim().min(1, 'is required').max(50, 'must be at most 50 characters');

const patientProfileSchema = z.strictObject({
  role: z.literal('PATIENT'),
  firstName: nameSchema,
  lastName: nameSchema,
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'must be a valid phone number')
    .optional(),
  dateOfBirth: dateSchema
    .refine((value) => value >= '1900-01-01' && value <= clinicNow(loadConfig().clinicTimezone).date, 'must be a real date of birth, not in the future')
    .optional(),
  gender: z.enum(['Male', 'Female', 'Other', 'Prefer not to say']).optional(),
});

const doctorProfileSchema = z.strictObject({
  role: z.literal('DOCTOR'),
  firstName: nameSchema,
  lastName: nameSchema,
  specialtyId: z.uuid('must be one of the listed specialties'),
  clinicId: z.uuid('must be one of the listed clinics'),
  consultationFee: z.int('must be a whole number').min(0, 'cannot be negative').max(100_000, 'is too high'),
  bio: z.string().trim().max(1000, 'must be at most 1000 characters').optional(),
});

export const profileSchema = z.discriminatedUnion('role', [patientProfileSchema, doctorProfileSchema]);
