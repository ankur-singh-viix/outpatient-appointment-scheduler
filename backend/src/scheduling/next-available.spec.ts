import { findNextAvailable, type NextAvailableInput } from './next-available.js';

// 2026-11-04 is a Wednesday. The doctor works Monday to Friday, 10:00-11:00, capacity 2, in 15-minute slots.
const weekdays = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: '10:00:00', endTime: '11:00:00', capacity: 2 }));

function input(overrides: Partial<NextAvailableInput> = {}): NextAvailableInput {
  return {
    consultationMinutes: 15,
    defaultCapacity: 10,
    weekly: weekdays,
    overrides: new Map(),
    booked: new Map(),
    today: { date: '2026-11-04', time: '08:00' },
    days: 14,
    ...overrides,
  };
}

describe('findNextAvailable', () => {
  it('offers the first slot of today when the session has not started', () => {
    expect(findNextAvailable(input())).toEqual({ date: '2026-11-04', startTime: '10:00', endTime: '10:15' });
  });

  it('skips today’s slots that have already started', () => {
    expect(findNextAvailable(input({ today: { date: '2026-11-04', time: '10:20' } }))).toEqual({
      date: '2026-11-04',
      startTime: '10:30',
      endTime: '10:45',
    });
  });

  it('moves to the next working day once today’s session is over', () => {
    expect(findNextAvailable(input({ today: { date: '2026-11-04', time: '11:00' } }))?.date).toBe('2026-11-05');
  });

  it('skips a taken slot', () => {
    expect(findNextAvailable(input({ booked: new Map([['2026-11-04', ['10:00']]]) }))?.startTime).toBe('10:15');
  });

  it('skips a day whose session is full, even if some slots are not individually booked', () => {
    const full = new Map([['2026-11-04', ['10:00', '10:15']]]); // capacity 2 reached
    expect(findNextAvailable(input({ booked: full }))).toEqual({ date: '2026-11-05', startTime: '10:00', endTime: '10:15' });
  });

  it('jumps over the weekend', () => {
    // Friday afternoon, after the session: the next working day is Monday.
    expect(findNextAvailable(input({ today: { date: '2026-11-06', time: '15:00' } }))?.date).toBe('2026-11-09');
  });

  it('skips a day off and honours custom hours on another date', () => {
    const overrides = new Map([
      ['2026-11-04', { isAvailable: false, startTime: null, endTime: null, capacity: null, reason: 'Conference' }],
      ['2026-11-05', { isAvailable: true, startTime: '14:00:00', endTime: '15:00:00', capacity: 1, reason: null }],
    ]);
    expect(findNextAvailable(input({ overrides }))).toEqual({ date: '2026-11-05', startTime: '14:00', endTime: '14:15' });
  });

  it('uses the doctor’s own slot length', () => {
    expect(findNextAvailable(input({ consultationMinutes: 30 }))).toEqual({ date: '2026-11-04', startTime: '10:00', endTime: '10:30' });
  });

  it('returns null when the doctor has no sessions, or nothing is free in the window', () => {
    expect(findNextAvailable(input({ weekly: [] }))).toBeNull();
    expect(findNextAvailable(input({ days: 1, today: { date: '2026-11-04', time: '12:00' } }))).toBeNull();
  });
});
