import { zonedInstant } from '../common/zoned-time.js';
import { DEFAULT_PREFERENCES, categoryOf, mayDeliver, reminderSchedule, type NotificationPreferences } from './notification-policy.js';
import { reminder } from './templates.js';

const prefs = (overrides: Partial<NotificationPreferences> = {}): NotificationPreferences => ({ ...DEFAULT_PREFERENCES, ...overrides });

describe('mayDeliver: essential, reminder and promotional messages', () => {
  it('always sends essential emails, whatever the patient has switched off', () => {
    const everythingOff = prefs({ smsEnabled: false, emailReminders: false, smsReminders: false, promotionalEmail: false, promotionalSms: false });
    expect(mayDeliver(everythingOff, 'transactional', 'email')).toBe(true);
    expect(mayDeliver(DEFAULT_PREFERENCES, 'transactional', 'email')).toBe(true);
  });

  it('sends essential texts unless texts are turned off', () => {
    expect(mayDeliver(DEFAULT_PREFERENCES, 'transactional', 'sms')).toBe(true);
    expect(mayDeliver(prefs({ smsEnabled: false }), 'transactional', 'sms')).toBe(false);
    expect(mayDeliver(prefs({ smsReminders: false }), 'transactional', 'sms')).toBe(true); // text reminders off does not affect essential texts
  });

  it('sends reminders per channel, and a reminder text also needs texts on', () => {
    expect(mayDeliver(DEFAULT_PREFERENCES, 'reminder', 'email')).toBe(true);
    expect(mayDeliver(DEFAULT_PREFERENCES, 'reminder', 'sms')).toBe(true);
    expect(mayDeliver(prefs({ emailReminders: false }), 'reminder', 'email')).toBe(false);
    expect(mayDeliver(prefs({ emailReminders: false }), 'reminder', 'sms')).toBe(true);
    expect(mayDeliver(prefs({ smsReminders: false }), 'reminder', 'sms')).toBe(false);
    expect(mayDeliver(prefs({ smsReminders: false }), 'reminder', 'email')).toBe(true);
    expect(mayDeliver(prefs({ smsEnabled: false }), 'reminder', 'sms')).toBe(false);
    expect(mayDeliver(prefs({ smsEnabled: false }), 'reminder', 'email')).toBe(true);
  });

  it('never sends anything promotional by default', () => {
    expect(mayDeliver(DEFAULT_PREFERENCES, 'promotional', 'email')).toBe(false);
    expect(mayDeliver(DEFAULT_PREFERENCES, 'promotional', 'sms')).toBe(false);
  });

  it('sends promotional messages only on a channel the patient opted in to, and a promotional text also needs texts on', () => {
    expect(mayDeliver(prefs({ promotionalEmail: true }), 'promotional', 'email')).toBe(true);
    expect(mayDeliver(prefs({ promotionalEmail: true }), 'promotional', 'sms')).toBe(false);
    expect(mayDeliver(prefs({ promotionalSms: true }), 'promotional', 'sms')).toBe(true);
    expect(mayDeliver(prefs({ promotionalSms: true }), 'promotional', 'email')).toBe(false);
    expect(mayDeliver(prefs({ promotionalSms: true, smsEnabled: false }), 'promotional', 'sms')).toBe(false);
  });

  it('covers every combination without ever letting a promotional message through unconsented, or blocking the essential email', () => {
    const flags = [true, false];
    for (const smsEnabled of flags)
      for (const emailReminders of flags)
        for (const smsReminders of flags)
          for (const promotionalEmail of flags)
            for (const promotionalSms of flags) {
              const p = { smsEnabled, emailReminders, smsReminders, promotionalEmail, promotionalSms };
              expect(mayDeliver(p, 'transactional', 'email')).toBe(true);
              expect(mayDeliver(p, 'promotional', 'email')).toBe(promotionalEmail);
              expect(mayDeliver(p, 'promotional', 'sms')).toBe(promotionalSms && smsEnabled);
            }
  });
});

describe('categoryOf', () => {
  it('knows the stored categories, and treats anything else as the most restricted, never as essential', () => {
    expect(categoryOf('transactional')).toBe('transactional');
    expect(categoryOf('reminder')).toBe('reminder');
    expect(categoryOf('promotional')).toBe('promotional');
    expect(categoryOf('marketing')).toBe('promotional');
    expect(categoryOf('')).toBe('promotional');
  });
});

describe('reminderSchedule', () => {
  const ist = (date: string, time: string) => zonedInstant(date, time, 'Asia/Kolkata');

  it('puts each reminder the configured number of real hours before the appointment, in clinic time', () => {
    const start = ist('2026-11-05', '10:15'); // 04:45 UTC
    const times = reminderSchedule(start, [24, 1], new Date('2026-11-01T00:00:00Z')).map(({ hours, sendAt }) => [hours, sendAt.toISOString()]);
    expect(times).toEqual([
      [24, '2026-11-04T04:45:00.000Z'], // 10:15 IST the day before
      [1, '2026-11-05T03:45:00.000Z'], // 09:15 IST
    ]);
  });

  it('supports any intervals, including fractions of an hour', () => {
    const start = ist('2026-11-05', '10:00');
    const hours = reminderSchedule(start, [48, 24, 2, 0.5], new Date('2026-11-01T00:00:00Z')).map(({ hours: h }) => h);
    expect(hours).toEqual([48, 24, 2, 0.5]);
    expect(reminderSchedule(start, [0.5], new Date('2026-11-01T00:00:00Z'))[0].sendAt.toISOString()).toBe('2026-11-05T04:00:00.000Z'); // 09:30 IST
  });

  it('drops intervals that have already passed, rather than sending them late as if on time', () => {
    const start = ist('2026-11-05', '10:00');
    const now = ist('2026-11-04', '20:00'); // 14 hours before
    expect(reminderSchedule(start, [24, 1], now).map(({ hours }) => hours)).toEqual([1]);
    expect(reminderSchedule(start, [24, 1], ist('2026-11-05', '09:30'))).toEqual([]);
    expect(reminderSchedule(start, [24, 1], new Date(start.getTime() - 3_600_000))).toEqual([]); // exactly at the moment: not in the future
  });

  it('counts real hours across a daylight-saving change: 24 hours before is not always the same wall-clock time', () => {
    // New York clocks went forward at 02:00 on 8 March 2026. An appointment at 09:00 that morning is 13:00 UTC (EDT, UTC-4).
    const start = zonedInstant('2026-03-08', '09:00', 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    const [day] = reminderSchedule(start, [24], new Date('2026-03-01T00:00:00Z'));
    expect(day.sendAt.toISOString()).toBe('2026-03-07T13:00:00.000Z'); // exactly 24 real hours earlier...
    expect(day.sendAt.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })).toBe('08:00'); // ...which is 08:00 on the clocks of the day before
  });

  it('is unaffected by the time zone of the machine running it', () => {
    const start = ist('2026-11-05', '10:15');
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(reminderSchedule(start, [1], new Date('2026-11-01T00:00:00Z'))[0].sendAt.toISOString()).toBe('2026-11-05T03:45:00.000Z');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('reminder wording', () => {
  const facts = { patientName: 'Rahul', doctorName: 'Dr. Rohan Das', clinicName: 'City Clinic', clinicAddress: '12 MG Road', date: '2026-11-05', startTime: '10:15', endTime: '10:30' };

  it('describes the real lead time in days, hours or minutes', () => {
    expect(reminder(facts, 24).body).toContain('in about 1 day.');
    expect(reminder(facts, 47.9).body).toContain('in about 2 days.');
    expect(reminder(facts, 5.2).body).toContain('in about 5 hours.');
    expect(reminder(facts, 1).body).toContain('in about 1 hour.');
    expect(reminder(facts, 0.5).body).toContain('in about 30 minutes.');
    expect(reminder(facts, 0.01).body).toContain('in about 1 minute.');
  });

  it('includes the full time range, and keeps the text version short', () => {
    expect(reminder(facts, 1).body).toContain('10:15 AM – 10:30 AM');
    expect(reminder(facts, 1).sms.length).toBeLessThanOrEqual(160);
    expect(reminder(facts, 1).sms).toMatch(/^CareSlot reminder: appointment with Dr\. Rohan Das/);
  });
});
