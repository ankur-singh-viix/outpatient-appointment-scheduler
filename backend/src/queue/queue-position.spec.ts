import type { QueueStatus } from '../database/entities/queue-entry.entity.js';
import { buildDay, effectiveStatus, positionOf, type DayRow } from './queue-position.js';

const row = (token: number, status: QueueStatus, appointmentStatus = 'CONFIRMED'): DayRow => ({ id: `t${token}`, token, status, appointmentStatus });

describe('effectiveStatus', () => {
  it('reads a cancelled or no-show appointment as cancelled, for patients still in the active queue only', () => {
    expect(effectiveStatus('WAITING', 'CANCELLED')).toBe('CANCELLED');
    expect(effectiveStatus('SERVING', 'CANCELLED')).toBe('CANCELLED');
    expect(effectiveStatus('WAITING', 'NO_SHOW')).toBe('CANCELLED');
  });

  it('leaves everything else as the entry says (a completed visit stays completed)', () => {
    expect(effectiveStatus('WAITING', 'CONFIRMED')).toBe('WAITING');
    expect(effectiveStatus('COMPLETED', 'COMPLETED')).toBe('COMPLETED');
    expect(effectiveStatus('CHECKED_OUT', 'COMPLETED')).toBe('CHECKED_OUT');
    expect(effectiveStatus('SKIPPED', 'CANCELLED')).toBe('SKIPPED');
  });
});

describe('buildDay', () => {
  it('orders the waiting patients by token, whatever order the rows come in', () => {
    const day = buildDay([row(3, 'WAITING'), row(1, 'WAITING'), row(2, 'WAITING')]);
    expect(day.waiting.map((entry) => entry.token)).toEqual([1, 2, 3]);
    expect(day.serving).toBeNull();
    expect(day.currentlyServingToken).toBeNull();
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

  it('keeps the order defined even if two entries are somehow being served: the lowest is served, the other waits', () => {
    const day = buildDay([row(2, 'SERVING'), row(1, 'SERVING'), row(3, 'WAITING')]);
    expect(day.serving?.token).toBe(1);
    expect(day.waiting.map((entry) => [entry.token, entry.status])).toEqual([[2, 'WAITING'], [3, 'WAITING']]);
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
  const day = buildDay([row(1, 'CHECKED_OUT', 'COMPLETED'), row(2, 'SERVING'), row(3, 'WAITING'), row(4, 'WAITING'), row(5, 'WAITING', 'CANCELLED'), row(6, 'WAITING'), row(7, 'SKIPPED')]);

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
    const afterComplete = buildDay([row(2, 'COMPLETED', 'COMPLETED'), row(3, 'WAITING'), row(4, 'WAITING')]);
    expect(positionOf(afterComplete, 't3')).toEqual({ status: 'WAITING', ahead: 0, behind: 1, currentlyServingToken: null });
    const afterCancel = buildDay([row(3, 'WAITING', 'CANCELLED'), row(4, 'WAITING'), row(5, 'WAITING')]);
    expect(positionOf(afterCancel, 't5')).toMatchObject({ ahead: 1, behind: 0 });
  });

  it('a skipped patient who is returned keeps their token, so they are called in token order again', () => {
    const returned = buildDay([row(1, 'WAITING'), row(2, 'SERVING'), row(3, 'WAITING')]);
    expect(positionOf(returned, 't1')).toMatchObject({ ahead: 1, behind: 1 });
    expect(returned.waiting.map((entry) => entry.token)).toEqual([1, 3]);
  });

  it('knows nothing of an entry that is not in the day', () => {
    expect(positionOf(day, 'nobody')).toBeNull();
  });
});
