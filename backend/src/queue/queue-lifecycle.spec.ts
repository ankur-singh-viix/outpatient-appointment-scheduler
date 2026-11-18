import { QUEUE_STATUSES, type QueueStatus } from '../database/entities/queue-entry.entity.js';
import { ACTIVE_QUEUE_STATUSES, QUEUE_TRANSITIONS, assertQueueTransition, canQueueTransition, eventFor } from './queue-lifecycle.js';

describe('queue lifecycle', () => {
  it('has an entry for every status, and the final ones lead nowhere', () => {
    expect(Object.keys(QUEUE_TRANSITIONS).sort((x, y) => x.localeCompare(y))).toEqual([...QUEUE_STATUSES].sort((x, y) => x.localeCompare(y)));
    for (const final of ['CHECKED_OUT', 'CANCELLED'] as QueueStatus[]) expect(QUEUE_TRANSITIONS[final]).toEqual([]);
  });

  it('allows exactly the moves the queue has', () => {
    const allowed: [QueueStatus, QueueStatus][] = [
      ['BOOKED', 'WAITING'],
      ['BOOKED', 'CANCELLED'],
      ['WAITING', 'SERVING'],
      ['WAITING', 'SKIPPED'],
      ['WAITING', 'CANCELLED'],
      ['SERVING', 'COMPLETED'],
      ['SERVING', 'SKIPPED'],
      ['SERVING', 'CANCELLED'],
      ['COMPLETED', 'CHECKED_OUT'],
      ['SKIPPED', 'WAITING'],
      ['SKIPPED', 'CANCELLED'],
    ];
    for (const from of QUEUE_STATUSES) {
      for (const to of QUEUE_STATUSES) {
        expect(canQueueTransition(from, to), `${from} -> ${to}`).toBe(allowed.some(([f, t]) => f === from && t === to));
      }
    }
  });

  it('checkout is only possible after completion, and a waiting or serving patient cannot be checked out', () => {
    for (const from of ['BOOKED', 'WAITING', 'SERVING', 'SKIPPED', 'CANCELLED'] as QueueStatus[]) expect(canQueueTransition(from, 'CHECKED_OUT')).toBe(false);
    expect(canQueueTransition('COMPLETED', 'CHECKED_OUT')).toBe(true);
  });

  it('a finished patient can never be called or completed again', () => {
    for (const from of ['COMPLETED', 'CHECKED_OUT', 'CANCELLED'] as QueueStatus[]) {
      expect(canQueueTransition(from, 'SERVING')).toBe(false);
      expect(canQueueTransition(from, 'COMPLETED')).toBe(false);
    }
  });

  it('explains a refused move in plain words, with a code', () => {
    expect(() => assertQueueTransition('WAITING', 'CHECKED_OUT')).toThrow('This patient is waiting and cannot become checked out.');
    expect(() => assertQueueTransition('CHECKED_OUT', 'SERVING')).toThrow(/checked out and cannot become being served/);
    try {
      assertQueueTransition('COMPLETED', 'SERVING');
    } catch (error) {
      expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({ statusCode: 409, code: 'INVALID_QUEUE_TRANSITION' });
    }
    expect(() => assertQueueTransition('WAITING', 'SERVING')).not.toThrow();
    expect(() => assertQueueTransition('BOOKED', 'WAITING')).not.toThrow();
  });

  it('names the audit event for each move', () => {
    expect(eventFor(null, 'BOOKED')).toBe('BOOKED');
    expect(eventFor(null, 'WAITING')).toBe('CHECKED_IN');
    expect(eventFor('BOOKED', 'WAITING')).toBe('CHECKED_IN');
    expect(eventFor('WAITING', 'SERVING')).toBe('CALLED');
    expect(eventFor('SERVING', 'COMPLETED')).toBe('COMPLETED');
    expect(eventFor('COMPLETED', 'CHECKED_OUT')).toBe('CHECKED_OUT');
    expect(eventFor('SERVING', 'SKIPPED')).toBe('SKIPPED');
    expect(eventFor('SKIPPED', 'WAITING')).toBe('RETURNED');
    expect(eventFor('SERVING', 'CANCELLED')).toBe('CANCELLED');
  });

  it('only waiting and serving patients are in the active queue', () => {
    expect([...ACTIVE_QUEUE_STATUSES]).toEqual(['WAITING', 'SERVING']);
  });
});
