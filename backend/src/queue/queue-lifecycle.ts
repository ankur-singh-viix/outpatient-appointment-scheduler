import { ConflictException } from '@nestjs/common';
import type { QueueEventName, QueueStatus } from '../database/entities/queue-entry.entity.js';

/**
 * Which status a queue entry may move to from each status. The whole queue lifecycle in one place; every writer checks it first.
 *
 *   WAITING      -> SERVING (the doctor calls the patient), SKIPPED (not here), CANCELLED
 *   SERVING      -> COMPLETED (the doctor finishes), SKIPPED (called but absent), CANCELLED
 *   COMPLETED    -> CHECKED_OUT (the receptionist checks the patient out)
 *   SKIPPED      -> WAITING (the receptionist returns the patient to the queue, keeping their token)
 *   CHECKED_OUT, CANCELLED -> nothing: they are final
 *
 * CANCELLED is only ever written when a cancelled appointment would otherwise block the queue (a patient being "served" whose
 * appointment was cancelled). Everywhere else a cancelled appointment is recognised from the appointment's own status.
 */
export const QUEUE_TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  WAITING: ['SERVING', 'SKIPPED', 'CANCELLED'],
  SERVING: ['COMPLETED', 'SKIPPED', 'CANCELLED'],
  COMPLETED: ['CHECKED_OUT'],
  CHECKED_OUT: [],
  SKIPPED: ['WAITING'],
  CANCELLED: [],
};

/** The patients still to be seen or being seen. Everything else has left the active queue. */
export const ACTIVE_QUEUE_STATUSES: readonly QueueStatus[] = ['WAITING', 'SERVING'];

export function canQueueTransition(from: QueueStatus, to: QueueStatus): boolean {
  return QUEUE_TRANSITIONS[from].includes(to);
}

const WORDS: Record<QueueStatus, string> = {
  WAITING: 'waiting',
  SERVING: 'being served',
  COMPLETED: 'completed',
  CHECKED_OUT: 'checked out',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
};

/** Throws a 409 for a move the queue does not allow, so a finished patient can never be called again or checked out twice. */
export function assertQueueTransition(from: QueueStatus, to: QueueStatus): void {
  if (!canQueueTransition(from, to)) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'INVALID_QUEUE_TRANSITION',
      message: `This patient is ${WORDS[from]} and cannot become ${WORDS[to]}.`,
    });
  }
}

/** The audit event name for a move. */
export function eventFor(from: QueueStatus | null, to: QueueStatus): QueueEventName {
  if (from === null) return 'CHECKED_IN';
  if (to === 'SERVING') return 'CALLED';
  if (to === 'COMPLETED') return 'COMPLETED';
  if (to === 'CHECKED_OUT') return 'CHECKED_OUT';
  if (to === 'SKIPPED') return 'SKIPPED';
  if (to === 'CANCELLED') return 'CANCELLED';
  return 'RETURNED';
}
