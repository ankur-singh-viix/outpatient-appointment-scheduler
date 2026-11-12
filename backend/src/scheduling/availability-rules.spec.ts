import { describe, expect, it } from 'vitest';
import { appliesOn, effectiveRangesIntersect, inheritedSettings, resolveDay, ruleProblem, type AvailabilityRule } from './availability-rules.js';
import { buildSlots, nextFreeSeat, type DateOverride } from './slots.js';

// 2030-01-07 is a Monday (day 1).
const MONDAY = '2030-01-07';
const DOCTOR = { consultationMinutes: 20, defaultCapacity: 20 };

function rule(overrides: Partial<AvailabilityRule> = {}): AvailabilityRule {
  return {
    id: 'weekly-1',
    recurrenceType: 'WEEKLY',
    dayOfWeek: 1,
    specificDate: null,
    startTime: '09:00',
    endTime: '10:00',
    capacity: 10,
    schedulingMode: 'STREAM',
    slotDurationMinutes: 20,
    capacityPerSlot: 1,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

const oneTime = (overrides: Partial<AvailabilityRule> = {}) =>
  rule({ id: 'one-time-1', recurrenceType: 'ONE_TIME', dayOfWeek: null, specificDate: MONDAY, ...overrides });

const override = (value: Partial<DateOverride>): DateOverride => ({ isAvailable: true, startTime: null, endTime: null, capacity: null, reason: null, ...value });

/** Sessions for a date, cut into slots. `booked` are start-end windows of active appointments, with an optional seat. */
function slotsFor(rules: AvailabilityRule[], opts: { date?: string; override?: DateOverride | null; booked?: { startTime: string; endTime: string; slotNumber?: number }[]; cutoff?: string | null } = {}) {
  const sessions = resolveDay(opts.override ?? null, rules, opts.date ?? MONDAY, DOCTOR);
  return buildSlots(sessions, DOCTOR.consultationMinutes, opts.booked ?? [], opts.cutoff ?? null).slots;
}

const times = (slots: { startTime: string }[]) => slots.map((slot) => slot.startTime);

describe('weekly availability', () => {
  it('applies on its weekday only', () => {
    expect(times(slotsFor([rule()]))).toEqual(['09:00', '09:20', '09:40']);
    expect(slotsFor([rule()], { date: '2030-01-08' })).toEqual([]); // Tuesday
  });

  it('respects its effective date range', () => {
    const seasonal = rule({ effectiveFrom: '2030-02-01', effectiveTo: '2030-02-28' });
    expect(appliesOn(seasonal, MONDAY)).toBe(false); // before the range
    expect(appliesOn(seasonal, '2030-02-04')).toBe(true); // a Monday inside it
    expect(appliesOn(seasonal, '2030-03-04')).toBe(false); // a Monday after it
  });
});

describe('one-time availability', () => {
  it('applies on its date only', () => {
    expect(appliesOn(oneTime(), MONDAY)).toBe(true);
    expect(appliesOn(oneTime(), '2030-01-14')).toBe(false); // the next Monday
    expect(times(slotsFor([oneTime()], { date: '2030-01-14' }))).toEqual([]);
  });

  it('adds hours the weekly schedule does not have, leaving the weekly hours alone', () => {
    const slots = slotsFor([rule(), oneTime({ startTime: '17:00', endTime: '18:00' })]);
    expect(times(slots)).toEqual(['09:00', '09:20', '09:40', '17:00', '17:20', '17:40']);
  });
});

describe('one-time precedence over weekly', () => {
  it('wins the time it overlaps and leaves the weekly slots outside it', () => {
    // Weekly 09:00-12:00 in 20-minute STREAM slots; a one-time WAVE session 10:00-11:00 in 30-minute slots of 3 patients.
    const weekly = rule({ endTime: '12:00' });
    const special = oneTime({ startTime: '10:00', endTime: '11:00', schedulingMode: 'WAVE', slotDurationMinutes: 30, capacityPerSlot: 3 });
    const slots = slotsFor([weekly, special]);
    expect(slots.map((slot) => `${slot.startTime}-${slot.endTime}/${slot.mode}`)).toEqual([
      '09:00-09:20/STREAM',
      '09:20-09:40/STREAM',
      '09:40-10:00/STREAM',
      '10:00-10:30/WAVE', // the one-time session's slots...
      '10:30-11:00/WAVE',
      '11:00-11:20/STREAM', // ...and no weekly slot overlapping 10:00-11:00
      '11:20-11:40/STREAM',
      '11:40-12:00/STREAM',
    ]);
    expect(slots.find((slot) => slot.startTime === '10:00')?.availabilityId).toBe('one-time-1');
  });

  it('is independent of the order the rows come back in', () => {
    const weekly = rule({ endTime: '12:00' });
    const special = oneTime({ startTime: '10:00', endTime: '11:00' });
    expect(slotsFor([weekly, special])).toEqual(slotsFor([special, weekly]));
  });

  it('ignores a one-time row outside its effective dates', () => {
    const stale = oneTime({ startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 5, effectiveTo: '2029-12-31' });
    expect(slotsFor([rule(), stale]).every((slot) => slot.mode === 'STREAM')).toBe(true);
  });
});

describe('overlapping rows of the same kind', () => {
  it('give the overlap to the earlier-starting row, and never offer one moment twice', () => {
    const a = rule({ id: 'a', startTime: '09:00', endTime: '10:00' });
    const b = rule({ id: 'b', startTime: '09:40', endTime: '10:40' });
    const slots = slotsFor([b, a]);
    expect(slots.map((slot) => [slot.startTime, slot.endTime])).toEqual([
      ['09:00', '09:20'],
      ['09:20', '09:40'],
      ['09:40', '10:00'],
      ['10:00', '10:20'], // b's grid starts at 09:40: its first slot overlaps a's last, so it is dropped
      ['10:20', '10:40'],
    ]);
  });
});

describe('schedule overrides', () => {
  it('a day off removes every session, whatever the weekly and one-time rows say', () => {
    expect(resolveDay(override({ isAvailable: false, reason: 'Conference' }), [rule(), oneTime()], MONDAY, DOCTOR)).toEqual([]);
  });

  it('available hours replace the whole day, including one-time rows, and keep the mode and slot length the day would have had', () => {
    const special = oneTime({ startTime: '10:00', endTime: '11:00', schedulingMode: 'WAVE', slotDurationMinutes: 30, capacityPerSlot: 4 });
    const sessions = resolveDay(override({ startTime: '13:00', endTime: '14:00', capacity: 8 }), [rule(), special], MONDAY, DOCTOR);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ source: 'OVERRIDE', startTime: '13:00', endTime: '14:00', mode: 'WAVE', slotMinutes: 30, capacityPerSlot: 4, availabilityId: null });
    expect(inheritedSettings([rule()], MONDAY, DOCTOR)).toEqual({ mode: 'STREAM', slotMinutes: 20, capacityPerSlot: 1 });
  });

  it('available hours on a day with no schedule are STREAM slots of the doctor\'s length', () => {
    const sessions = resolveDay(override({ startTime: '09:00', endTime: '10:00', capacity: 5 }), [], MONDAY, DOCTOR);
    expect(sessions[0]).toMatchObject({ mode: 'STREAM', slotMinutes: 20, capacityPerSlot: 1 });
  });
});

describe('partial-day override', () => {
  it('blocks only the slots that overlap the blocked time; the rest of the day is offered', () => {
    const day = rule({ startTime: '09:00', endTime: '11:00' });
    const slots = slotsFor([day], { override: override({ isAvailable: false, startTime: '09:30', endTime: '10:10' }) });
    // 09:20-09:40, 09:40-10:00 and 10:00-10:20 touch 09:30-10:10; 09:00-09:20 and everything from 10:20 survive.
    expect(times(slots)).toEqual(['09:00', '10:20', '10:40']);
  });

  it('blocks one-time sessions as well, and an unrelated block changes nothing', () => {
    const special = oneTime({ startTime: '15:00', endTime: '16:00' });
    expect(times(slotsFor([special], { override: override({ isAvailable: false, startTime: '15:00', endTime: '15:20' }) }))).toEqual(['15:20', '15:40']);
    expect(times(slotsFor([special], { override: override({ isAvailable: false, startTime: '08:00', endTime: '09:00' }) }))).toEqual(['15:00', '15:20', '15:40']);
  });

  it('back-to-back blocked time does not remove the neighbouring slot', () => {
    const slots = slotsFor([rule()], { override: override({ isAvailable: false, startTime: '09:20', endTime: '09:40' }) });
    expect(times(slots)).toEqual(['09:00', '09:40']);
  });
});

describe('WAVE slot generation', () => {
  const wave = rule({ id: 'wave-1', startTime: '09:00', endTime: '11:00', schedulingMode: 'WAVE', slotDurationMinutes: 30, capacityPerSlot: 3, capacity: null });

  it('cuts the window into back-to-back slots, each with its capacity', () => {
    const slots = slotsFor([wave]);
    expect(slots.map((slot) => [slot.startTime, slot.endTime, slot.capacityPerSlot, slot.remaining])).toEqual([
      ['09:00', '09:30', 3, 3],
      ['09:30', '10:00', 3, 3],
      ['10:00', '10:30', 3, 3],
      ['10:30', '11:00', 3, 3],
    ]);
  });

  it('is not stretched by the doctor\'s slot interval', () => {
    const sessions = resolveDay(null, [wave], MONDAY, DOCTOR);
    const { slots } = buildSlots(sessions, DOCTOR.consultationMinutes, [], null, 10); // an interval of 10 minutes would overlap STREAM slots
    expect(slots).toHaveLength(4);
  });

  it('counts each slot independently: seats left shrink, and a slot is BOOKED only when every seat is taken', () => {
    const at = (startTime: string, endTime: string, slotNumber: number) => ({ startTime, endTime, slotNumber });
    const slots = slotsFor([wave], {
      booked: [at('09:00', '09:30', 1), at('09:00', '09:30', 2), at('09:30', '10:00', 1), at('10:00', '10:30', 1), at('10:00', '10:30', 2), at('10:00', '10:30', 3)],
    });
    expect(slots.map((slot) => [slot.startTime, slot.status, slot.booked, slot.remaining])).toEqual([
      ['09:00', 'AVAILABLE', 2, 1],
      ['09:30', 'AVAILABLE', 1, 2],
      ['10:00', 'BOOKED', 3, 0], // capacity reached
      ['10:30', 'AVAILABLE', 0, 3],
    ]);
  });

  it('has no session-wide cap: a WAVE session reports every seat it offers', () => {
    const { sessions } = buildSlots(resolveDay(null, [wave], MONDAY, DOCTOR), DOCTOR.consultationMinutes, [], null);
    expect(sessions[0]).toMatchObject({ capacity: 12, booked: 0, remaining: 12 });
  });

  it('drops past slots from "available" but keeps them marked PAST', () => {
    const slots = slotsFor([wave], { cutoff: '09:45' });
    expect(slots.map((slot) => slot.status)).toEqual(['PAST', 'PAST', 'AVAILABLE', 'AVAILABLE']);
  });
});

describe('STREAM slots', () => {
  it('take exactly one patient: an occupied slot is BOOKED and an overlapping one too', () => {
    const slots = slotsFor([rule()], { booked: [{ startTime: '09:20', endTime: '09:40' }] });
    expect(slots.map((slot) => [slot.startTime, slot.status, slot.capacityPerSlot, slot.remaining])).toEqual([
      ['09:00', 'AVAILABLE', 1, 1],
      ['09:20', 'BOOKED', 1, 0],
      ['09:40', 'AVAILABLE', 1, 1],
    ]);
  });

  it('ignore a capacity per slot above 1: STREAM never takes two patients', () => {
    const sneaky = rule({ capacityPerSlot: 5 });
    expect(slotsFor([sneaky]).every((slot) => slot.capacityPerSlot === 1)).toBe(true);
  });

  it('are FULL once the session cap is reached, as they always were', () => {
    const slots = slotsFor([rule({ capacity: 1 })], { booked: [{ startTime: '09:00', endTime: '09:20' }] });
    expect(slots.map((slot) => slot.status)).toEqual(['BOOKED', 'FULL', 'FULL']);
  });
});

describe('seats', () => {
  const slot = { startTime: '09:00', endTime: '09:30' };

  it('hands out the lowest free seat, and null when none is left', () => {
    expect(nextFreeSeat([], slot, 3)).toBe(1);
    expect(nextFreeSeat([{ ...slot, slotNumber: 1 }], slot, 3)).toBe(2);
    expect(nextFreeSeat([{ ...slot, slotNumber: 2 }], slot, 3)).toBe(1); // a freed seat is reused
    expect(nextFreeSeat([1, 2, 3].map((slotNumber) => ({ ...slot, slotNumber })), slot, 3)).toBeNull();
  });

  it('treats an appointment with no seat as seat 1, and ignores appointments elsewhere', () => {
    expect(nextFreeSeat([{ ...slot }], slot, 2)).toBe(2);
    expect(nextFreeSeat([{ startTime: '10:00', endTime: '10:30', slotNumber: 1 }], slot, 2)).toBe(1);
  });
});

describe('invalid rows', () => {
  const valid = {
    recurrenceType: 'WEEKLY' as const,
    dayOfWeek: 1,
    specificDate: null,
    startTime: '09:00',
    endTime: '10:00',
    schedulingMode: 'STREAM' as const,
    slotDurationMinutes: 20,
    capacityPerSlot: 1,
    effectiveFrom: null,
    effectiveTo: null,
  };

  it('accepts a valid weekly and a valid one-time row', () => {
    expect(ruleProblem(valid)).toBeNull();
    expect(ruleProblem({ ...valid, recurrenceType: 'ONE_TIME', dayOfWeek: null, specificDate: MONDAY })).toBeNull();
    expect(ruleProblem({ ...valid, schedulingMode: 'WAVE', capacityPerSlot: 4 })).toBeNull();
  });

  it('rejects invalid time ranges', () => {
    expect(ruleProblem({ ...valid, startTime: '10:00', endTime: '09:00' })).toMatch(/after startTime/);
    expect(ruleProblem({ ...valid, startTime: '09:00', endTime: '09:00' })).toMatch(/after startTime/);
    expect(ruleProblem({ ...valid, slotDurationMinutes: 90 })).toMatch(/at least 90 minutes/);
    expect(ruleProblem({ ...valid, slotDurationMinutes: 0 })).toMatch(/slotDurationMinutes/);
  });

  it('rejects invalid recurrence combinations', () => {
    expect(ruleProblem({ ...valid, dayOfWeek: null })).toMatch(/dayOfWeek is required/);
    expect(ruleProblem({ ...valid, specificDate: MONDAY })).toMatch(/specificDate must not be set/);
    expect(ruleProblem({ ...valid, recurrenceType: 'ONE_TIME', dayOfWeek: null, specificDate: null })).toMatch(/specificDate is required/);
    expect(ruleProblem({ ...valid, recurrenceType: 'ONE_TIME', dayOfWeek: 1, specificDate: MONDAY })).toMatch(/dayOfWeek must not be set/);
  });

  it('rejects invalid capacity and effective dates', () => {
    expect(ruleProblem({ ...valid, schedulingMode: 'WAVE', capacityPerSlot: 0 })).toMatch(/capacityPerSlot/);
    expect(ruleProblem({ ...valid, schedulingMode: 'STREAM', capacityPerSlot: 3 })).toMatch(/exactly one patient/);
    expect(ruleProblem({ ...valid, effectiveFrom: '2030-02-01', effectiveTo: '2030-01-01' })).toMatch(/effectiveTo/);
  });
});

describe('effective range overlap', () => {
  it('treats an open end as unbounded and touching ranges as overlapping', () => {
    const range = (effectiveFrom: string | null, effectiveTo: string | null) => ({ effectiveFrom, effectiveTo });
    expect(effectiveRangesIntersect(range(null, null), range('2030-01-01', '2030-01-31'))).toBe(true);
    expect(effectiveRangesIntersect(range('2030-01-01', '2030-01-31'), range('2030-02-01', null))).toBe(false);
    expect(effectiveRangesIntersect(range('2030-01-01', '2030-01-31'), range('2030-01-31', null))).toBe(true);
  });
});
