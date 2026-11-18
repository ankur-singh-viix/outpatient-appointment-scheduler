import type { QueueStatus } from '../database/entities/queue-entry.entity.js';
import { buildDay, compareWaitingOrder, effectiveStatus, positionOf, type DayRow } from './queue-position.js';

const row = (
  token: number,
  status: QueueStatus,
  appointmentStatus = 'CONFIRMED',
  checkedInAt: string | null = status === 'WAITING' || status === 'SERVING' ? `2026-11-16T04:0${token}:00Z` : null,
): DayRow => ({ id: `t${token}`, token, status, appointmentStatus, checkedInAt });

describe('effectiveStatus', () => {
  it('reads a cancelled or no-show appointment as cancelled for booked, waiting, serving or skipped entries', () => {
    expect(effectiveStatus('WAITING', 'CANCELLED')).toBe('CANCELLED');
    expect(effectiveStatus('SERVING', 'CANCELLED')).toBe('CANCELLED');
    expect(effectiveStatus('WAITING', 'NO_SHOW')).toBe('CANCELLED');
    expect(effectiveStatus('BOOKED', 'NO_SHOW')).toBe('CANCELLED');
    expect(effectiveStatus('SKIPPED', 'NO_SHOW')).toBe('CANCELLED');
    expect(effectiveStatus('SKIPPED', 'CANCELLED')).toBe('CANCELLED');
  });

  it('leaves everything else as the entry says (a completed visit stays completed)', () => {
    expect(effectiveStatus('WAITING', 'CONFIRMED')).toBe('WAITING');
    expect(effectiveStatus('COMPLETED', 'COMPLETED')).toBe('COMPLETED');
    expect(effectiveStatus('CHECKED_OUT', 'COMPLETED')).toBe('CHECKED_OUT');
    expect(effectiveStatus('SKIPPED', 'CONFIRMED')).toBe('SKIPPED');
  });

  it('keeps a BOOKED token visible as arriving even if the appointment was incorrectly marked COMPLETED', () => {
    // Desk Late Arrival / No Show still apply; the queue service restores CONFIRMED before acting.
    expect(effectiveStatus('BOOKED', 'COMPLETED')).toBe('BOOKED');
    expect(buildDay([row(3, 'BOOKED', 'COMPLETED')]).booked.map((entry) => entry.token)).toEqual([3]);
  });
});

describe('buildDay', () => {
  it('orders waiting patients by check-in time, not token number', () => {
    const day = buildDay([
      row(3, 'WAITING', 'CONFIRMED', '2026-11-16T04:10:00Z'),
      row(1, 'WAITING', 'CONFIRMED', '2026-11-16T04:30:00Z'),
      row(2, 'WAITING', 'CONFIRMED', '2026-11-16T04:20:00Z'),
    ]);
    expect(day.waiting.map((entry) => entry.token)).toEqual([3, 2, 1]);
    expect(day.serving).toBeNull();
    expect(day.currentlyServingToken).toBeNull();
  });

  it('puts a late lower token after people already waiting (FIFO)', () => {
    const day = buildDay([
      row(4, 'WAITING', 'CONFIRMED', '2026-11-16T04:00:00Z'),
      row(3, 'WAITING', 'CONFIRMED', '2026-11-16T04:45:00Z'),
    ]);
    expect(day.waiting.map((entry) => entry.token)).toEqual([4, 3]);
    expect(compareWaitingOrder(day.waiting[0], day.waiting[1])).toBeLessThan(0);
  });

  it('separates serving, waiting, completed, checked out, skipped and cancelled', () => {
    const day = buildDay([row(1, 'CHECKED_OUT', 'COMPLETED'), row(2, 'COMPLETED', 'COMPLETED'), row(3, 'SERVING'), row(4, 'WAITING'), row(5, 'SKIPPED'), row(6, 'WAITING', 'CANCELLED')]);
    expect(day.currentlyServingToken).toBe(3);
    expect(day.serving?.token).toBe(3);
    expect(day.waiting.map((entry) => entry.token)).toEqual([4]);
    expect(day.completed.map((entry) => entry.token)).toEqual([2]);
    expect(day.checkedOut.map((entry) => entry.token)).toEqual([1]);
    expect(day.skipped.map((entry) => entry.token)).toEqual([5]);
    expect(day.cancelled.map((entry) => entry.token)).toEqual([6]);
  });

  it('keeps the order defined even if two entries are somehow being served: earliest check-in is served', () => {
    const day = buildDay([
      row(2, 'SERVING', 'CONFIRMED', '2026-11-16T04:10:00Z'),
      row(1, 'SERVING', 'CONFIRMED', '2026-11-16T04:00:00Z'),
      row(3, 'WAITING', 'CONFIRMED', '2026-11-16T04:20:00Z'),
    ]);
    expect(day.serving?.token).toBe(1);
    expect(day.waiting.map((entry) => [entry.token, entry.status])).toEqual([
      [2, 'WAITING'],
      [3, 'WAITING'],
    ]);
  });

  it('an empty day has nothing in it', () => {
    expect(buildDay([])).toEqual({ currentlyServingToken: null, serving: null, booked: [], waiting: [], completed: [], checkedOut: [], skipped: [], cancelled: [] });
  });

  it('keeps BOOKED entries (token reserved at booking) apart from the waiting list', () => {
    const day = buildDay([row(1, 'BOOKED'), row(2, 'WAITING'), row(3, 'BOOKED')]);
    expect(day.booked.map((entry) => entry.token)).toEqual([1, 3]);
    expect(day.waiting.map((entry) => entry.token)).toEqual([2]);
  });

  it('treats a cancelled booking that still has a BOOKED token as cancelled', () => {
    expect(buildDay([row(4, 'BOOKED', 'CANCELLED')]).cancelled.map((entry) => entry.token)).toEqual([4]);
  });
});

describe('positionOf: patients ahead and behind', () => {
  const day = buildDay([
    row(1, 'CHECKED_OUT', 'COMPLETED'),
    row(2, 'SERVING', 'CONFIRMED', '2026-11-16T04:00:00Z'),
    row(3, 'WAITING', 'CONFIRMED', '2026-11-16T04:10:00Z'),
    row(4, 'WAITING', 'CONFIRMED', '2026-11-16T04:20:00Z'),
    row(5, 'WAITING', 'CANCELLED'),
    row(6, 'WAITING', 'CONFIRMED', '2026-11-16T04:30:00Z'),
    row(7, 'SKIPPED'),
  ]);

  it('counts the patient being served as ahead of everyone waiting', () => {
    expect(positionOf(day, 't3')).toEqual({ status: 'WAITING', ahead: 1, behind: 2, currentlyServingToken: 2 });
  });

  it('counts only waiting patients as ahead and behind, never cancelled, skipped or finished ones', () => {
    expect(positionOf(day, 't4')).toEqual({ status: 'WAITING', ahead: 2, behind: 1, currentlyServingToken: 2 });
    expect(positionOf(day, 't6')).toEqual({ status: 'WAITING', ahead: 3, behind: 0, currentlyServingToken: 2 });
  });

  it('puts nobody ahead of the patient being served, and everyone waiting behind', () => {
    expect(positionOf(day, 't2')).toEqual({ status: 'SERVING', ahead: 0, behind: 3, currentlyServingToken: 2 });
  });

  it('gives a patient who has left the active queue no place in it', () => {
    for (const id of ['t1', 't5', 't7']) expect(positionOf(day, id)).toMatchObject({ ahead: null, behind: null });
    expect(positionOf(day, 't5')?.status).toBe('CANCELLED');
    expect(positionOf(day, 't7')?.status).toBe('SKIPPED');
  });

  it('moves everyone up when the patient being served is completed, or a waiting one cancels', () => {
    const afterComplete = buildDay([
      row(2, 'COMPLETED', 'COMPLETED'),
      row(3, 'WAITING', 'CONFIRMED', '2026-11-16T04:10:00Z'),
      row(4, 'WAITING', 'CONFIRMED', '2026-11-16T04:20:00Z'),
    ]);
    expect(positionOf(afterComplete, 't3')).toEqual({ status: 'WAITING', ahead: 0, behind: 1, currentlyServingToken: null });
    const afterCancel = buildDay([
      row(3, 'WAITING', 'CANCELLED'),
      row(4, 'WAITING', 'CONFIRMED', '2026-11-16T04:20:00Z'),
      row(5, 'WAITING', 'CONFIRMED', '2026-11-16T04:30:00Z'),
    ]);
    expect(positionOf(afterCancel, 't5')).toMatchObject({ ahead: 1, behind: 0 });
  });

  it('a returned patient with a later check-in joins the end of the wait line, keeping their token', () => {
    const returned = buildDay([
      row(1, 'WAITING', 'CONFIRMED', '2026-11-16T05:00:00Z'),
      row(2, 'SERVING', 'CONFIRMED', '2026-11-16T04:00:00Z'),
      row(3, 'WAITING', 'CONFIRMED', '2026-11-16T04:10:00Z'),
    ]);
    expect(returned.waiting.map((entry) => entry.token)).toEqual([3, 1]);
    expect(positionOf(returned, 't1')).toMatchObject({ ahead: 2, behind: 0 });
    expect(positionOf(returned, 't3')).toMatchObject({ ahead: 1, behind: 1 });
  });

  it('knows nothing of an entry that is not in the day', () => {
    expect(positionOf(day, 'nobody')).toBeNull();
  });
});
