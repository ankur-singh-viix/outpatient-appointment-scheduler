import { QueryFailedError } from 'typeorm';

const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';

/** True when PostgreSQL rejected a write because it would break a unique constraint or index. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;
}

/**
 * True when PostgreSQL rejected a booking because the slot is taken: either the exact start time is already used (unique
 * index) or the appointment would overlap another one for the same doctor (exclusion constraint, migration 007).
 */
export function isSlotConflict(error: unknown): boolean {
  if (isUniqueViolation(error)) return true;
  return error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === EXCLUSION_VIOLATION;
}
