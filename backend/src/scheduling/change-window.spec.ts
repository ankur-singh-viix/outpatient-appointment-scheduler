import { describeBlock, insideWindow, windowLimit, whenText } from './change-window.js';
import type { AvailabilityRule } from './availability-rules.js';
import { findAffected, findRestored, type ElasticDoctor } from './elastic.js';
import type { DateOverride } from './slots.js';

const at = (date: string, time: string) => ({ date, time });

describe('windowLimit', () => {
  it('adds the hours in the clinic-local clock, carrying into the next day', () => {
    expect(windowLimit(at('2026-11-10', '07:00'), 2)).toEqual(at('2026-11-10', '09:00'));
    expect(windowLimit(at('2026-11-10', '22:30'), 2)).toEqual(at('2026-11-11', '00:30'));
    expect(windowLimit(at('2026-12-31', '23:59'), 1)).toEqual(at('2027-01-01', '00:59'));
    expect(windowLimit(at('2026-11-10', '12:00'), 0.5)).toEqual(at('2026-11-10', '12:30'));
  });
});

describe('insideWindow (the mentor example: a 9 AM appointment)', () => {
  const nine = { date: '2026-11-10', startTime: '09:00', endTime: '09:30' };

  it('with a one-hour window, blocks from 8 AM onward but not before', () => {
    expect(insideWindow(nine, at('2026-11-10', '07:59'), 1)).toBe(false);
    expect(insideWindow(nine, at('2026-11-10', '08:00'), 1)).toBe(true); // exactly one hour away is inside
    expect(insideWindow(nine, at('2026-11-10', '08:30'), 1)).toBe(true);
  });

  it('with a two-hour window, blocks from 7 AM onward', () => {
    expect(insideWindow(nine, at('2026-11-10', '06:59'), 2)).toBe(false);
    expect(insideWindow(nine, at('2026-11-10', '07:00'), 2)).toBe(true);
  });

  it('keeps blocking while the appointment is under way, and stops once it has finished', () => {
    expect(insideWindow(nine, at('2026-11-10', '09:00'), 2)).toBe(true);
    expect(insideWindow(nine, at('2026-11-10', '09:29'), 2)).toBe(true);
    expect(insideWindow(nine, at('2026-11-10', '09:30'), 2)).toBe(false);
    expect(insideWindow(nine, at('2026-11-10', '14:00'), 2)).toBe(false);
  });

  it('counts across midnight: a 00:30 appointment is inside a two-hour window from 22:30 the evening before', () => {
    const early = { date: '2026-11-11', startTime: '00:30', endTime: '01:00' };
    expect(insideWindow(early, at('2026-11-10', '22:29'), 2)).toBe(false);
    expect(insideWindow(early, at('2026-11-10', '22:30'), 2)).toBe(true);
  });

  it('is off with 0 hours, and a later day is outside a short window', () => {
    expect(insideWindow(nine, at('2026-11-10', '09:10'), 0)).toBe(false);
    expect(insideWindow({ ...nine, date: '2026-11-12' }, at('2026-11-10', '20:00'), 2)).toBe(false);
  });
});

describe('describeBlock', () => {
  const blocked = [
    { id: 'b', date: '2026-11-10', startTime: '10:00', endTime: '10:30', patientName: 'Rahul Sharma' },
    { id: 'a', date: '2026-11-10', startTime: '09:00', endTime: '09:30', patientName: 'Ankur Kumar' },
  ];

  it('names the earliest appointment and says when the change becomes possible', () => {
    const block = describeBlock(blocked, 2, at('2026-11-10', '08:15'));
    expect(block?.earliest.id).toBe('a');
    expect(block?.blocked.map((b) => b.id)).toEqual(['a', 'b']);
    expect(block?.allowedFrom).toEqual(at('2026-11-10', '10:30')); // once the last one has finished
    expect(block?.message).toContain("Ankur Kumar's appointment");
    expect(block?.message).toContain('9:00 AM');
    expect(block?.message).toContain('less than 2 hours away');
    expect(block?.message).toContain('after those appointments finish');
    expect(block?.message).toContain('10:30 AM');
  });

  it('says "started" for one already under way, and singular wording for one', () => {
    const block = describeBlock([blocked[1]], 1, at('2026-11-10', '09:10'));
    expect(block?.message).toContain('which started');
    expect(block?.message).toContain('less than 1 hour away');
    expect(block?.message).toContain('after that appointment finishes');
  });

  it('is undefined when nothing is blocked', () => {
    expect(describeBlock([], 2, at('2026-11-10', '08:00'))).toBeUndefined();
  });

  it('formats times for the doctor', () => {
    expect(whenText('2026-11-10', '09:05')).toBe('Tue, 10 Nov at 9:05 AM');
  });
});

describe('what-if for a change of date exception (findAffected / findRestored with afterOverrides)', () => {
  const doctor: ElasticDoctor = { consultationMinutes: 30, defaultCapacity: 20, slotIntervalMinutes: 30 };
  const MONDAY = '2030-01-07';
  const rule: AvailabilityRule = {
    id: 'r1',
    recurrenceType: 'WEEKLY',
    dayOfWeek: 1,
    specificDate: null,
    startTime: '10:00',
    endTime: '12:00',
    capacity: null,
    schedulingMode: 'WAVE',
    slotDurationMinutes: 30,
    capacityPerSlot: 2,
    effectiveFrom: null,
    effectiveTo: null,
  };
  const dayOff: DateOverride = { isAvailable: false, startTime: null, endTime: null, capacity: null, reason: null };
  const block: DateOverride = { isAvailable: false, startTime: '11:00', endTime: '12:00', capacity: null, reason: null };
  const appointments = [
    { id: 'early', date: MONDAY, startTime: '10:00', endTime: '10:30' },
    { id: 'late', date: MONDAY, startTime: '11:30', endTime: '12:00' },
  ];
  const none = new Map<string, DateOverride>();
  const base = { appointments, rules: [rule], afterRules: [rule], overrides: none, doctor };

  it('a day off affects every appointment that day; a blocked part of the day only those inside it', () => {
    expect(findAffected({ ...base, afterOverrides: new Map([[MONDAY, dayOff]]) })).toEqual(['early', 'late']);
    expect(findAffected({ ...base, afterOverrides: new Map([[MONDAY, block]]) })).toEqual(['late']);
  });

  it('lifting the exception restores exactly what it had stranded', () => {
    const before = new Map([[MONDAY, block]]);
    expect(findRestored({ ...base, overrides: before, afterOverrides: none })).toEqual(['late']);
    expect(findRestored({ ...base, overrides: new Map([[MONDAY, dayOff]]), afterOverrides: none })).toEqual(['early', 'late']);
  });

  it('replacement hours affect only what they leave outside, and an exception elsewhere changes nothing', () => {
    const replacement: DateOverride = { isAvailable: true, startTime: '10:00', endTime: '11:00', capacity: 5, reason: null };
    expect(findAffected({ ...base, afterOverrides: new Map([[MONDAY, replacement]]) })).toEqual(['late']);
    expect(findAffected({ ...base, afterOverrides: new Map([['2030-01-14', dayOff]]) })).toEqual([]);
  });

  it('ignores dates before fromDate (a change that starts later)', () => {
    expect(findAffected({ ...base, afterOverrides: new Map([[MONDAY, dayOff]]), fromDate: '2030-01-08' })).toEqual([]);
  });

  it('is unchanged when no after-exceptions are given', () => {
    expect(findAffected({ ...base, afterRules: [{ ...rule, endTime: '11:00' }] })).toEqual(['late']);
  });
});
