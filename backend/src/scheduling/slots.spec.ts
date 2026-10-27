import { addDays, clinicNow, dayOfWeek, isValidDate } from './calendar.js';
import { buildSlots, resolveSessions, type DateOverride } from './slots.js';

const weekly = [
  { startTime: '17:00:00', endTime: '18:00:00', capacity: 2 },
  { startTime: '09:00:00', endTime: '10:00:00', capacity: 3 },
];

describe('resolveSessions', () => {
  it('uses the weekly schedule, sorted by start time, when there is no override', () => {
    expect(resolveSessions(null, weekly, 20)).toEqual([
      { startTime: '09:00', endTime: '10:00', capacity: 3, source: 'WEEKLY' },
      { startTime: '17:00', endTime: '18:00', capacity: 2, source: 'WEEKLY' },
    ]);
  });

  it('lets a date override replace the weekly schedule', () => {
    const override: DateOverride = { isAvailable: true, startTime: '12:00:00', endTime: '13:00:00', capacity: 4, reason: null };
    expect(resolveSessions(override, weekly, 20)).toEqual([
      { startTime: '12:00', endTime: '13:00', capacity: 4, source: 'OVERRIDE' },
    ]);
  });

  it('returns no sessions on a day off', () => {
    const dayOff: DateOverride = { isAvailable: false, startTime: null, endTime: null, capacity: null, reason: 'Leave' };
    expect(resolveSessions(dayOff, weekly, 20)).toEqual([]);
  });

  it("falls back to the doctor's default capacity when an override has none", () => {
    const override: DateOverride = { isAvailable: true, startTime: '12:00', endTime: '13:00', capacity: null, reason: null };
    expect(resolveSessions(override, [], 7)[0].capacity).toBe(7);
  });
});

describe('buildSlots', () => {
  const sessions = resolveSessions(null, weekly, 20);

  it('splits each session into consultation-length slots', () => {
    const { slots } = buildSlots(sessions, 20, [], null);
    expect(slots.map((slot) => `${slot.startTime}-${slot.endTime}`)).toEqual([
      '09:00-09:20',
      '09:20-09:40',
      '09:40-10:00',
      '17:00-17:20',
      '17:20-17:40',
      '17:40-18:00',
    ]);
    expect(slots.every((slot) => slot.status === 'AVAILABLE')).toBe(true);
  });

  it('drops a trailing slot that would run past the end of the session', () => {
    const { slots } = buildSlots([{ startTime: '09:00', endTime: '09:50', capacity: 5, source: 'WEEKLY' }], 20, [], null);
    expect(slots.map((slot) => slot.startTime)).toEqual(['09:00', '09:20']);
  });

  it('marks booked slots and counts them against their own session only', () => {
    const result = buildSlots(sessions, 20, ['09:20:00', '17:00:00'], null);
    expect(result.slots.find((slot) => slot.startTime === '09:20')?.status).toBe('BOOKED');
    expect(result.sessions.map((s) => [s.booked, s.remaining])).toEqual([
      [1, 2],
      [1, 1],
    ]);
  });

  it('marks the remaining slots FULL once a session reaches capacity', () => {
    const result = buildSlots(sessions, 20, ['17:00', '17:20'], null);
    const evening = result.slots.filter((slot) => slot.startTime >= '17:00');
    expect(evening.map((slot) => slot.status)).toEqual(['BOOKED', 'BOOKED', 'FULL']);
    // The morning session is unaffected.
    expect(result.slots.filter((slot) => slot.startTime < '12:00').every((slot) => slot.status === 'AVAILABLE')).toBe(true);
  });

  it('marks slots at or before the cut-off time as PAST', () => {
    const { slots } = buildSlots(sessions, 20, [], '09:20');
    expect(slots.slice(0, 3).map((slot) => slot.status)).toEqual(['PAST', 'PAST', 'AVAILABLE']);
  });
});

describe('calendar helpers', () => {
  it('validates real calendar dates only', () => {
    expect(isValidDate('2026-10-27')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('27-10-2026')).toBe(false);
  });

  it('maps dates to day_of_week with 0 = Sunday', () => {
    expect(dayOfWeek('2026-10-25')).toBe(0);
    expect(dayOfWeek('2026-10-31')).toBe(6);
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });

  it('reports the current date and time in the clinic time zone', () => {
    // 20:00 UTC is 01:30 the next day in India (UTC+5:30).
    expect(clinicNow('Asia/Kolkata', new Date('2026-10-27T20:00:00Z'))).toEqual({ date: '2026-10-28', time: '01:30' });
  });
});
