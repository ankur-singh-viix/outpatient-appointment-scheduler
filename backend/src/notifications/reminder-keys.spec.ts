import { reminderSchedule } from './notification-policy.js';
import { canonicalHours, parseReminderKey, reminderKey, reminderSlot } from './reminder-keys.js';

const ID = '3f2b8c1e-5d4a-4b7e-9c10-0a1b2c3d4e5f';

describe('reminder keys', () => {
  it('writes an interval one way only, so "24", "24.0" and 24 are the same reminder', () => {
    expect(canonicalHours(24)).toBe('24');
    expect(canonicalHours(24.0)).toBe('24');
    expect(canonicalHours(Number('24.000'))).toBe('24');
    expect(canonicalHours(0.5)).toBe('0.5');
    expect(canonicalHours(1.00001)).toBe('1');
    expect(canonicalHours(2.5)).toBe('2.5');
  });

  it('builds the key for each channel, keeping the email key the one used since reminders began', () => {
    expect(reminderKey(ID, 24)).toBe(`reminder:${ID}:24`);
    expect(reminderKey(ID, 24, 'sms')).toBe(`reminder:${ID}:24:sms`);
    expect(reminderKey(ID, 0.5)).toBe(`reminder:${ID}:0.5`);
    expect(reminderKey(ID, 24.0)).toBe(reminderKey(ID, 24));
  });

  it('reads a key back into its appointment, interval and channel', () => {
    expect(parseReminderKey(`reminder:${ID}:24`)).toEqual({ appointmentId: ID, hours: 24, channel: 'email' });
    expect(parseReminderKey(`reminder:${ID}:1:sms`)).toEqual({ appointmentId: ID, hours: 1, channel: 'sms' });
    expect(parseReminderKey(`reminder:${ID}:0.5`)).toEqual({ appointmentId: ID, hours: 0.5, channel: 'email' });
    expect(parseReminderKey(`reminder:${ID.toUpperCase()}:24`)?.hours).toBe(24);
  });

  it('round-trips every key it builds', () => {
    for (const hours of [24, 1, 0.5, 48, 2.25]) {
      for (const channel of ['email', 'sms'] as const) {
        expect(parseReminderKey(reminderKey(ID, hours, channel))).toEqual({ appointmentId: ID, hours, channel });
      }
    }
  });

  it('does not mistake any other key for a reminder, so those are never touched', () => {
    for (const key of [`booking-confirmed:${ID}`, `payment-received:pay_1`, `reminder:${ID}`, `reminder:${ID}:abc`, `reminder:${ID}:0`, `reminder:${ID}:-1`, `reminder:not-an-id:24`, `reminder:${ID}:24:email`, '']) {
      expect(parseReminderKey(key)).toBeNull();
    }
  });

  it('gives the same reminder the same identity whatever its key looked like, and different intervals or channels different ones', () => {
    expect(reminderSlot(ID, 24, 'email')).toBe(reminderSlot(ID, 24.0, 'email'));
    expect(reminderSlot(ID, 24, 'email')).not.toBe(reminderSlot(ID, 1, 'email')); // the 24-hour and 1-hour reminders are different reminders
    expect(reminderSlot(ID, 24, 'email')).not.toBe(reminderSlot(ID, 24, 'sms'));
    expect(reminderSlot(ID, 24, 'email')).not.toBe(reminderSlot('another-appointment', 24, 'email'));
  });
});

describe('reminderSchedule with a repeated interval', () => {
  const start = new Date('2026-11-05T04:45:00Z');
  const now = new Date('2026-11-01T00:00:00Z');

  it('schedules one reminder per distinct interval, in the configured order', () => {
    expect(reminderSchedule(start, [24, 24, 1], now).map(({ hours }) => hours)).toEqual([24, 1]);
    expect(reminderSchedule(start, [24, 24.0, 1, 1.0], now).map(({ hours }) => hours)).toEqual([24, 1]);
  });

  it('keeps the 24-hour and the 1-hour reminders as two separate reminders, at their own times', () => {
    const times = reminderSchedule(start, [24, 1], now).map(({ hours, sendAt }) => [hours, sendAt.toISOString()]);
    expect(times).toEqual([
      [24, '2026-11-04T04:45:00.000Z'],
      [1, '2026-11-05T03:45:00.000Z'],
    ]);
  });
});
