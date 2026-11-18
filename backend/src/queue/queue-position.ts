import type { QueueStatus } from '../database/entities/queue-entry.entity.js';

/** One queue entry joined with its appointment's own status. `token` is the token number. */
export interface DayRow {
  id: string;
  token: number;
  /** The status stored on the queue entry. */
  status: QueueStatus;
  /** The status of the appointment the entry belongs to. */
  appointmentStatus: string;
  /**
   * When the patient joined the active wait line (server check-in time). Used to order WAITING so late arrivals join the end
   * without cutting ahead of people already waiting. Null while BOOKED.
   */
  checkedInAt?: Date | string | null;
}

/**
 * What the entry really is right now. A patient still in the active queue (waiting or being served) whose appointment has been
 * cancelled, or marked no-show, is no longer in the queue, whatever the entry says: cancellations are read from the appointment, never
 * copied, so the existing cancel and reschedule flows need no knowledge of the queue.
 */
export function effectiveStatus(stored: QueueStatus, appointmentStatus: string): QueueStatus {
  if (
    (stored === 'BOOKED' || stored === 'WAITING' || stored === 'SERVING' || stored === 'SKIPPED') &&
    (appointmentStatus === 'CANCELLED' || appointmentStatus === 'NO_SHOW')
  ) {
    return 'CANCELLED';
  }
  return stored;
}

export interface Day<T extends DayRow> {
  /** The token being served right now, or null. */
  currentlyServingToken: number | null;
  serving: T | null;
  /** Confirmed bookings with a token who have not checked in yet. */
  booked: T[];
  /** Waiting patients in call order: earliest check-in first (late arrivals join the end); token breaks ties. */
  waiting: T[];
  completed: T[];
  checkedOut: T[];
  skipped: T[];
  cancelled: T[];
}

/** Milliseconds since epoch for check-in ordering; missing times sort last among waiters (should not happen for WAITING). */
function checkInMs(row: DayRow): number {
  if (row.checkedInAt == null) return Number.POSITIVE_INFINITY;
  const ms = row.checkedInAt instanceof Date ? row.checkedInAt.getTime() : Date.parse(String(row.checkedInAt));
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Call order among waiting patients: check-in time ascending, then token number. */
export function compareWaitingOrder(a: DayRow, b: DayRow): number {
  const byCheckIn = checkInMs(a) - checkInMs(b);
  return byCheckIn !== 0 ? byCheckIn : a.token - b.token;
}

/**
 * One doctor's day, worked out from the entries themselves (never from stored counts): who is being served, who is waiting and in
 * what order, and who has left. Every row comes back with its effective status. If two entries were somehow both being served (the
 * database forbids it), the earliest check-in is served and the other waits, so the order stays defined.
 */
export function buildDay<T extends DayRow>(rows: T[]): Day<T> {
  const withStatus = [...rows].map((row) => ({ ...row, status: effectiveStatus(row.status, row.appointmentStatus) }));
  const byToken = [...withStatus].sort((a, b) => a.token - b.token);
  const servingRows = [...withStatus.filter((row) => row.status === 'SERVING')].sort(compareWaitingOrder);
  const serving = servingRows[0] ?? null;
  const waiting = withStatus
    .filter((row) => row.status === 'WAITING' || (row.status === 'SERVING' && row !== serving))
    .map((row) => (row.status === 'SERVING' ? { ...row, status: 'WAITING' as const } : row))
    .sort(compareWaitingOrder);
  return {
    currentlyServingToken: serving?.token ?? null,
    serving,
    booked: byToken.filter((row) => row.status === 'BOOKED'),
    waiting,
    completed: byToken.filter((row) => row.status === 'COMPLETED'),
    checkedOut: byToken.filter((row) => row.status === 'CHECKED_OUT'),
    skipped: byToken.filter((row) => row.status === 'SKIPPED'),
    cancelled: byToken.filter((row) => row.status === 'CANCELLED'),
  };
}

export interface Position {
  status: QueueStatus;
  /** Patients to be seen before this one (the patient being served counts), or null once they have left the active queue. */
  ahead: number | null;
  /** Patients waiting after this one, or null once they have left the active queue. */
  behind: number | null;
  currentlyServingToken: number | null;
}

/**
 * Where one entry stands. The order is: the patient being served, then waiting patients by check-in time (then token). A waiting
 * patient has the served patient and everyone earlier in that waiting list ahead of them. Skipped, completed, checked out or
 * cancelled patients are not in the active queue and have no place in it.
 */
export function positionOf<T extends DayRow>(day: Day<T>, id: string): Position | null {
  const all = [day.serving, ...day.waiting, ...day.booked, ...day.completed, ...day.checkedOut, ...day.skipped, ...day.cancelled].filter((row): row is T => row !== null);
  const row = all.find((candidate) => candidate.id === id);
  if (!row) return null;
  const base = { status: row.status, currentlyServingToken: day.currentlyServingToken };
  if (row.status === 'SERVING') return { ...base, ahead: 0, behind: day.waiting.length };
  if (row.status === 'WAITING') {
    const index = day.waiting.findIndex((other) => other.id === row.id);
    return {
      ...base,
      ahead: (day.serving ? 1 : 0) + Math.max(0, index),
      behind: Math.max(0, day.waiting.length - index - 1),
    };
  }
  return { ...base, ahead: null, behind: null };
}
