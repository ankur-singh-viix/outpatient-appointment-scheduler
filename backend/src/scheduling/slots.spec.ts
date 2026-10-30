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

describe('buildSlots with a slot interval shorter or longer than the appointment', () => {
  const session = [{ startTime: '11:00', endTime: '12:30', capacity: 10, source: 'WEEKLY' as const }];
  const ranges = (slots: { startTime: string; endTime: string }[]) => slots.map((slot) => `${slot.startTime}-${slot.endTime}`);

  it('generates overlapping windows: 30-minute appointments starting every 15 minutes', () => {
    const { slots } = buildSlots(session, 30, [], null, 15);
    expect(ranges(slots)).toEqual(['11:00-11:30', '11:15-11:45', '11:30-12:00', '11:45-12:15', '12:00-12:30']);
  });

  it('keeps slots back to back when no interval is given, exactly as before', () => {
    expect(ranges(buildSlots(session, 30, [], null).slots)).toEqual(['11:00-11:30', '11:30-12:00', '12:00-12:30']);
    expect(ranges(buildSlots(session, 30, [], null, 30).slots)).toEqual(['11:00-11:30', '11:30-12:00', '12:00-12:30']);
  });

  it('leaves gaps when the interval is longer than the appointment', () => {
    const { slots } = buildSlots(session, 20, [], null, 30);
    expect(ranges(slots)).toEqual(['11:00-11:20', '11:30-11:50', '12:00-12:20']);
  });

  it.each([
    [15, 15, 6],
    [20, 10, 8],
    [25, 10, 7],
    [30, 5, 13],
    [45, 15, 4],
    [60, 30, 2],
  ])('offers every start that fits: %i-minute appointments every %i minutes in a 90-minute session', (duration, interval, expected) => {
    const { slots } = buildSlots(session, duration, [], null, interval);
    expect(slots).toHaveLength(expected);
    for (const slot of slots) {
      expect(toMinutesOf(slot.endTime) - toMinutesOf(slot.startTime)).toBe(duration);
      expect(toMinutesOf(slot.endTime)).toBeLessThanOrEqual(12 * 60 + 30); // always finishes inside the session
    }
    slots.slice(1).forEach((slot, index) => expect(toMinutesOf(slot.startTime) - toMinutesOf(slots[index].startTime)).toBe(interval));
  });

  it('never offers an appointment that would run past the end of the session', () => {
    const { slots } = buildSlots([{ startTime: '09:00', endTime: '09:50', capacity: 5, source: 'WEEKLY' }], 30, [], null, 10);
    expect(ranges(slots)).toEqual(['09:00-09:30', '09:10-09:40', '09:20-09:50']);
  });

  it('blocks every window that overlaps a booking, but not windows that merely touch it', () => {
    // 11:15-11:45 is booked. 11:00-11:30, 11:15-11:45 and 11:30-12:00 share time with it; 11:45-12:15 and 12:00-12:30 do not.
    const { slots } = buildSlots(session, 30, [{ startTime: '11:15', endTime: '11:45' }], null, 15);
    expect(Object.fromEntries(slots.map((slot) => [slot.startTime, slot.status]))).toEqual({
      '11:00': 'BOOKED',
      '11:15': 'BOOKED',
      '11:30': 'BOOKED',
      '11:45': 'AVAILABLE',
      '12:00': 'AVAILABLE',
    });
  });

  it('lets an appointment that ends exactly when the next starts sit beside it', () => {
    const { slots } = buildSlots(session, 30, [{ startTime: '11:00', endTime: '11:30' }], null, 15);
    expect(slots.find((slot) => slot.startTime === '11:30')?.status).toBe('AVAILABLE');
    expect(slots.find((slot) => slot.startTime === '11:15')?.status).toBe('BOOKED');
  });

  it('blocks an overlapping slot even when an old appointment has a different length than the current one', () => {
    // A legacy 20-minute booking at 11:10; today the doctor sees 30-minute slots every 15 minutes.
    const { slots } = buildSlots(session, 30, [{ startTime: '11:10', endTime: '11:30' }], null, 15);
    expect(slots.filter((slot) => slot.status === 'BOOKED').map((slot) => slot.startTime)).toEqual(['11:00', '11:15']);
  });

  it('treats a plain booked start time as one appointment length starting then (the old behaviour)', () => {
    const { slots } = buildSlots(session, 30, ['11:30:00'], null);
    expect(Object.fromEntries(slots.map((slot) => [slot.startTime, slot.status]))).toEqual({ '11:00': 'AVAILABLE', '11:30': 'BOOKED', '12:00': 'AVAILABLE' });
  });

  it('counts an appointment against the session it starts in, whatever its length', () => {
    const result = buildSlots(session, 30, [{ startTime: '11:15', endTime: '11:45' }, { startTime: '12:00', endTime: '12:30' }], null, 15);
    expect(result.sessions[0]).toMatchObject({ booked: 2, remaining: 8 });
  });

  it('marks FULL when the session capacity is used up, even for windows that do not overlap a booking', () => {
    const small = [{ startTime: '11:00', endTime: '12:30', capacity: 1, source: 'WEEKLY' as const }];
    const { slots } = buildSlots(small, 30, [{ startTime: '11:00', endTime: '11:30' }], null, 15);
    expect(slots.map((slot) => slot.status)).toEqual(['BOOKED', 'BOOKED', 'FULL', 'FULL', 'FULL']);
  });

  it('marks slots that have started as PAST using their own start time', () => {
    const { slots } = buildSlots(session, 30, [], '11:20', 15);
    expect(slots.map((slot) => slot.status)).toEqual(['PAST', 'PAST', 'AVAILABLE', 'AVAILABLE', 'AVAILABLE']);
  });

  it('copes with a nonsensical interval instead of looping forever', () => {
    expect(buildSlots(session, 30, [], null, 0).slots.length).toBeGreaterThan(0);
    expect(buildSlots(session, 30, [], null, -5).slots.length).toBeGreaterThan(0);
  });
});

function toMinutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}
