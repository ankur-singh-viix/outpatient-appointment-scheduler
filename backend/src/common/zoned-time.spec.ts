import { zonedInstant } from './zoned-time.js';

describe('zonedInstant', () => {
  it('converts clinic time in India (UTC+05:30, no daylight saving)', () => {
    expect(zonedInstant('2026-11-02', '10:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-02T04:30:00.000Z');
    expect(zonedInstant('2026-11-02', '00:15', 'Asia/Kolkata').toISOString()).toBe('2026-11-01T18:45:00.000Z');
  });

  it('follows daylight saving: the same wall-clock time is a different instant in summer and winter', () => {
    expect(zonedInstant('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z'); // UTC-4
    expect(zonedInstant('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z'); // UTC-5
  });

  it('is correct on the day the clocks change', () => {
    expect(zonedInstant('2026-03-08', '09:00', 'America/New_York').toISOString()).toBe('2026-03-08T13:00:00.000Z'); // already summer time by 09:00
    expect(zonedInstant('2026-03-08', '01:00', 'America/New_York').toISOString()).toBe('2026-03-08T06:00:00.000Z'); // still winter time at 01:00
  });

  it('treats UTC as itself', () => {
    expect(zonedInstant('2026-11-02', '10:15', 'UTC').toISOString()).toBe('2026-11-02T10:15:00.000Z');
  });
});
