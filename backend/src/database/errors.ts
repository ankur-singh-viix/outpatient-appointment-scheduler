import { QueryFailedError } from 'typeorm';

const UNIQUE_VIOLATION = '23505';

/** True when PostgreSQL rejected a write because it would break a unique constraint or index. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;
}
