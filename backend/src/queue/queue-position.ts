import type { QueueStatus } from '../database/entities/queue-entry.entity.js';

/** One queue entry joined with its appointment's own status. `token` is the token number. */
export interface DayRow {
  id: string;
  token: number;
  /** The status stored on the queue entry. */
  status: QueueStatus;
  /** The status of the appointment the entry belongs to. */
  appointmentStatus: string;
}

/**
 * What the entry really is right now. A patient still in the active queue (waiting or being served) whose appointment has been
 * cancelled, or marked no-show, is no longer in the queue, whatever the entry says: cancellations are read from the appointment, never
 * copied, so the existing cancel and reschedule flows need no knowledge of the queue.
 */
export function effectiveStatus(stored: QueueStatus, appointmentStatus: string): QueueStatus {
  if ((stored === 'BOOKED' || stored === 'WAITING' || stored === 'SERVING') && (appointmentStatus === 'CANCELLED' || appointmentStatus === 'NO_SHOW')) {
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
  /** Waiting patients, lowest token first: the order they will be called in. */
  waiting: T[];
  completed: T[];
  checkedOut: T[];
  skipped: T[];
  cancelled: T[];
}

/**
 * One doctor's day, worked out from the entries themselves (never from stored counts): who is being served, who is waiting and in
 * what order, and who has left. Every row comes back with its effective status. If two entries were somehow both being served (the
 * database forbids it), the lowest token is the one served and the other is counted as waiting, so the order stays defined.
 */
export function buildDay<T extends DayRow>(rows: T[]): Day<T> {
  const ordered = [...rows].map((row) => ({ ...row, status: effectiveStatus(row.status, row.appointmentStatus) })).sort((a, b) => a.token - b.token);
  const servingRows = ordered.filter((row) => row.status === 'SERVING');
  const serving = servingRows[0] ?? null;
  const waiting = ordered.filter((row) => row.status === 'WAITING' || (row.status === 'SERVING' && row !== serving)).map((row) => (row.status === 'SERVING' ? { ...row, status: 'WAITING' as const } : row));
  return {
    currentlyServingToken: serving?.token ?? null,
    serving,
    booked: ordered.filter((row) => row.status === 'BOOKED'),
    waiting: waiting.sort((a, b) => a.token - b.token),
    completed: ordered.filter((row) => row.status === 'COMPLETED'),
    checkedOut: ordered.filter((row) => row.status === 'CHECKED_OUT'),
    skipped: ordered.filter((row) => row.status === 'SKIPPED'),
    cancelled: ordered.filter((row) => row.status === 'CANCELLED'),
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
 * Where one entry stands. The order is: the patient being served, then the waiting patients by token. A waiting patient has the
 * served patient and every lower waiting token ahead of them, and every higher waiting token behind them. A patient who is skipped,
 * completed, checked out or cancelled is not in the active queue and has no place in it.
 */
export function positionOf<T extends DayRow>(day: Day<T>, id: string): Position | null {
  const all = [day.serving, ...day.waiting, ...day.booked, ...day.completed, ...day.checkedOut, ...day.skipped, ...day.cancelled].filter((row): row is T => row !== null);
  const row = all.find((candidate) => candidate.id === id);
  if (!row) return null;
  const base = { status: row.status, currentlyServingToken: day.currentlyServingToken };
  if (row.status === 'SERVING') return { ...base, ahead: 0, behind: day.waiting.length };
  if (row.status === 'WAITING') {
    return {
      ...base,
      ahead: (day.serving ? 1 : 0) + day.waiting.filter((other) => other.token < row.token).length,
      behind: day.waiting.filter((other) => other.token > row.token).length,
    };
  }
  return { ...base, ahead: null, behind: null };
}
