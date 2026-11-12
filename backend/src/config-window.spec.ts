import { loadConfig } from './config.js';

describe('the minimum-notice window for schedule changes (SCHEDULE_CHANGE_MIN_NOTICE_HOURS)', () => {
  const saved = process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS;
    else process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = saved;
  });

  it('defaults to two hours', () => {
    delete process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS;
    expect(loadConfig().scheduleChangeNoticeHours).toBe(2);
  });

  it('can be one hour, a fraction, or 0 to switch it off', () => {
    for (const [value, expected] of [['1', 1], ['2', 2], ['0.5', 0.5], ['0', 0]] as const) {
      process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = value;
      expect(loadConfig().scheduleChangeNoticeHours, value).toBe(expected);
    }
  });

  it('falls back to the default for nonsense, and is capped at 72 hours', () => {
    for (const value of ['abc', '-3', '', 'NaN']) {
      process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = value;
      expect(loadConfig().scheduleChangeNoticeHours, value).toBe(2);
    }
    process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = '500';
    expect(loadConfig().scheduleChangeNoticeHours).toBe(72);
  });
});
