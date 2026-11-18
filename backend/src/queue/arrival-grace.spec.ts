import { ARRIVAL_GRACE_MINUTES, arrivalPhase, isLateArrival, minutesBetween } from './arrival-grace.js';

describe('arrival grace', () => {
  it('uses a 10–15 minute grace window', () => {
    expect(ARRIVAL_GRACE_MINUTES).toBeGreaterThanOrEqual(10);
    expect(ARRIVAL_GRACE_MINUTES).toBeLessThanOrEqual(15);
  });

  it('measures minutes between HH:MM times on the same day', () => {
    expect(minutesBetween('09:00', '09:15')).toBe(15);
    expect(minutesBetween('09:00', '08:50')).toBe(-10);
    expect(minutesBetween('09:00', '09:00')).toBe(0);
  });

  it('is on time before the start, late inside the grace, and no-show eligible after', () => {
    const base = { appointmentDate: '2026-11-18', startTime: '10:00', nowDate: '2026-11-18' };
    expect(arrivalPhase({ ...base, nowTime: '09:59' })).toBe('on_time');
    expect(arrivalPhase({ ...base, nowTime: '10:00' })).toBe('late');
    expect(arrivalPhase({ ...base, nowTime: '10:14' })).toBe('late');
    expect(arrivalPhase({ ...base, nowTime: '10:15' })).toBe('no_show_eligible');
    expect(arrivalPhase({ ...base, nowTime: '11:00' })).toBe('no_show_eligible');
  });

  it('treats earlier days as no-show eligible and later days as on time', () => {
    expect(arrivalPhase({ appointmentDate: '2026-11-17', startTime: '10:00', nowDate: '2026-11-18', nowTime: '09:00' })).toBe('no_show_eligible');
    expect(arrivalPhase({ appointmentDate: '2026-11-19', startTime: '10:00', nowDate: '2026-11-18', nowTime: '23:00' })).toBe('on_time');
  });

  it('flags a check-in at or after the start as a late arrival', () => {
    expect(isLateArrival({ appointmentDate: '2026-11-18', startTime: '10:00', checkedInAt: new Date(), nowDate: '2026-11-18', nowTime: '10:05' })).toBe(true);
    expect(isLateArrival({ appointmentDate: '2026-11-18', startTime: '10:00', checkedInAt: new Date(), nowDate: '2026-11-18', nowTime: '09:55' })).toBe(false);
  });
});
