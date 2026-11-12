import { describe, expect, it } from 'vitest';
import type { AvailabilityRule } from './availability-rules.js';
import { alignedStarts, classify, findAffected, findRestored, isCovered, openSlotsOn, planChange, slotsOn, slotStep, type ElasticDoctor, type Placed } from './elastic.js';
import type { DateOverride } from './slots.js';

// 2030-01-07 is a Monday; 2030-01-14 the next one. The window the plan looks at is two weeks.
const MONDAY = '2030-01-07';
const NEXT_MONDAY = '2030-01-14';
const LAST = '2030-01-20';
const DOCTOR: ElasticDoctor = { consultationMinutes: 30, defaultCapacity: 20, slotIntervalMinutes: 30 };

function rule(overrides: Partial<AvailabilityRule> = {}): AvailabilityRule {
  return {
    id: 'row-1',
    recurrenceType: 'WEEKLY',
    dayOfWeek: 1,
    specificDate: null,
    startTime: '10:00',
    endTime: '12:00',
    capacity: null,
    schedulingMode: 'STREAM',
    slotDurationMinutes: 30,
    capacityPerSlot: 1,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

const wave = (overrides: Partial<AvailabilityRule> = {}) => rule({ schedulingMode: 'WAVE', capacityPerSlot: 3, ...overrides });
const oneTime = (overrides: Partial<AvailabilityRule> = {}) => rule({ id: 'one-1', recurrenceType: 'ONE_TIME', dayOfWeek: null, specificDate: MONDAY, ...overrides });
const noOverrides = new Map<string, DateOverride>();

function plan(row: AvailabilityRule, proposed: { startTime: string; endTime: string }, extra: { rules?: AvailabilityRule[]; overrides?: Map<string, DateOverride>; applyFrom?: string; doctor?: ElasticDoctor } = {}) {
  return planChange({ row, proposed, rules: extra.rules ?? [row], overrides: extra.overrides ?? noOverrides, doctor: extra.doctor ?? DOCTOR, applyFrom: extra.applyFrom ?? MONDAY, lastDate: LAST });
}

const starts = (ranges: { startTime: string }[]) => ranges.map((range) => range.startTime);

describe('classify', () => {
  const current = { startTime: '10:00', endTime: '12:00' };
  it('tells growing from shrinking from both from nothing', () => {
    expect(classify(current, { startTime: '09:00', endTime: '12:00' })).toBe('EXPAND');
    expect(classify(current, { startTime: '10:00', endTime: '13:00' })).toBe('EXPAND');
    expect(classify(current, { startTime: '10:00', endTime: '11:00' })).toBe('SHRINK');
    expect(classify(current, { startTime: '10:30', endTime: '12:00' })).toBe('SHRINK');
    expect(classify(current, { startTime: '09:00', endTime: '11:00' })).toBe('MIXED');
    expect(classify(current, current)).toBe('NONE');
  });
});

describe('slotStep and alignedStarts', () => {
  it('steps by the slot length, except a Stream row of the doctor\'s own length, which follows the interval', () => {
    expect(slotStep(wave(), DOCTOR)).toBe(30);
    expect(slotStep(rule(), DOCTOR)).toBe(30);
    expect(slotStep(rule(), { ...DOCTOR, slotIntervalMinutes: 15 })).toBe(15); // overlapping stream slots
    expect(slotStep(wave(), { ...DOCTOR, slotIntervalMinutes: 15 })).toBe(30); // wave slots are always back to back
    expect(slotStep(rule({ slotDurationMinutes: 20 }), { ...DOCTOR, slotIntervalMinutes: 15 })).toBe(20); // its own length: no interval
  });

  it('offers the start times nearest a wanted one that keep the grid', () => {
    expect(alignedStarts('10:00', '09:15', 30)).toEqual(['09:00', '09:30']);
    expect(alignedStarts('10:00', '10:45', 30)).toEqual(['10:30', '11:00']);
  });
});

describe('expansion', () => {
  it('Stream recurring, start earlier: adds only the new slots, keeps every existing one, adds no duplicates', () => {
    const row = rule();
    const result = plan(row, { startTime: '09:00', endTime: '12:00' });
    expect(result).toMatchObject({ kind: 'EXPAND', problems: [], addedSlots: 4, removedSlots: 0 }); // 2 slots on each of 2 Mondays
    expect(result.days.map((day) => day.date)).toEqual([MONDAY, NEXT_MONDAY]);
    expect(starts(result.days[0].added)).toEqual(['09:00', '09:30']);

    const before = slotsOn(MONDAY, [row], null, DOCTOR).slots.map((slot) => slot.startTime);
    const after = slotsOn(MONDAY, [{ ...row, startTime: '09:00' }], null, DOCTOR).slots.map((slot) => slot.startTime);
    expect(before.every((time) => after.includes(time))).toBe(true); // nothing that existed moved or went away
    expect(new Set(after).size).toBe(after.length); // and no slot is listed twice
    expect(after).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('Stream recurring, end later: adds only the slots after the old end', () => {
    const result = plan(rule(), { startTime: '10:00', endTime: '13:00' });
    expect(result).toMatchObject({ kind: 'EXPAND', problems: [], addedSlots: 4 });
    expect(starts(result.days[0].added)).toEqual(['12:00', '12:30']);
  });

  it('Wave recurring: keeps the slot length and the places per slot of the new slots', () => {
    const row = wave();
    const result = plan(row, { startTime: '09:00', endTime: '13:00' });
    expect(result).toMatchObject({ kind: 'EXPAND', problems: [], addedSlots: 8 });
    const slots = slotsOn(MONDAY, [{ ...row, startTime: '09:00', endTime: '13:00' }], null, DOCTOR).slots;
    expect(slots).toHaveLength(8);
    expect(slots.every((slot) => slot.capacityPerSlot === 3 && slot.mode === 'WAVE' && slot.endTime > slot.startTime)).toBe(true);
    expect(slots.map((slot) => slot.startTime)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
  });

  it('non-recurring (Wave and Stream): changes only its own date', () => {
    for (const mode of [oneTime(), oneTime({ schedulingMode: 'WAVE', capacityPerSlot: 2 })]) {
      const result = plan(mode, { startTime: '09:00', endTime: '12:00' });
      expect(result).toMatchObject({ kind: 'EXPAND', problems: [], addedSlots: 2 });
      expect(result.days.map((day) => day.date)).toEqual([MONDAY]); // not the following Monday
    }
  });

  it('leaves other sessions and other weekdays alone', () => {
    const tuesday = rule({ id: 'tue', dayOfWeek: 2 });
    const result = plan(rule(), { startTime: '09:00', endTime: '12:00' }, { rules: [rule(), tuesday] });
    expect(result.days.every((day) => new Date(`${day.date}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
  });

  it('applies from the chosen date on, and not before it', () => {
    const result = plan(rule(), { startTime: '09:00', endTime: '12:00' }, { applyFrom: NEXT_MONDAY });
    expect(result.days.map((day) => day.date)).toEqual([NEXT_MONDAY]);
  });

  it('respects the session\'s own effective dates', () => {
    const result = plan(rule({ effectiveTo: '2030-01-10' }), { startTime: '09:00', endTime: '12:00' });
    expect(result.days.map((day) => day.date)).toEqual([MONDAY]);
  });

  it('does not touch a date that has a date exception: the exception decides that day', () => {
    const overrides = new Map<string, DateOverride>([
      [MONDAY, { isAvailable: false, startTime: null, endTime: null, capacity: null, reason: 'Conference' }], // day off
    ]);
    const result = plan(rule(), { startTime: '09:00', endTime: '12:00' }, { overrides });
    expect(result.days.map((day) => day.date)).toEqual([NEXT_MONDAY]);

    const replacement = new Map<string, DateOverride>([[MONDAY, { isAvailable: true, startTime: '14:00', endTime: '16:00', capacity: 4, reason: null }]]);
    expect(plan(rule(), { startTime: '09:00', endTime: '12:00' }, { overrides: replacement }).days.map((day) => day.date)).toEqual([NEXT_MONDAY]);
  });

  it('on a date with a blocked part, the new slots appear except where the block is', () => {
    const overrides = new Map<string, DateOverride>([[MONDAY, { isAvailable: false, startTime: '09:00', endTime: '09:30', capacity: null, reason: null }]]);
    const result = plan(rule(), { startTime: '09:00', endTime: '12:00' }, { overrides });
    expect(starts(result.days.find((day) => day.date === MONDAY)!.added)).toEqual(['09:30']);
  });

  it('refuses a start that would shift the existing slot grid, and says which starts work', () => {
    const result = plan(rule(), { startTime: '09:15', endTime: '12:00' });
    expect(result.problems[0]).toMatch(/steps of 30 minutes/);
    expect(result.suggestedStarts).toEqual(['09:00', '09:30']);
    expect(result.days).toEqual([]);
  });

  it('uses the interval as the step for a Stream row that follows it', () => {
    const interval = { ...DOCTOR, slotIntervalMinutes: 15 };
    expect(plan(rule(), { startTime: '09:45', endTime: '12:00' }, { doctor: interval }).problems).toEqual([]);
    expect(plan(rule(), { startTime: '09:50', endTime: '12:00' }, { doctor: interval }).problems[0]).toMatch(/steps of 15 minutes/);
  });

  it('lets the end move freely, but says so when the extra time cannot hold a slot', () => {
    expect(plan(rule(), { startTime: '10:00', endTime: '12:45' }).problems).toEqual([]); // room for a 12:00 slot
    expect(plan(rule(), { startTime: '10:00', endTime: '12:10' }).problems[0]).toMatch(/shorter than one 30-minute slot/);
  });

  it('never counts the session being edited, or a finished one that ended before the change starts, as an overlap', () => {
    const editing = rule({ id: 'now', startTime: '09:00', endTime: '10:00', effectiveFrom: null, effectiveTo: null });
    const ended = rule({ id: 'history', startTime: '09:00', endTime: '10:00', effectiveFrom: null, effectiveTo: '2030-01-06' }); // ended the day before the change starts
    expect(plan(editing, { startTime: '09:30', endTime: '10:00' }, { rules: [editing] }).problems).toEqual([]);
    const result = plan(editing, { startTime: '09:30', endTime: '10:00' }, { rules: [ended, editing], applyFrom: MONDAY });
    expect(result.problems).toEqual([]);
    expect(result.kind).toBe('SHRINK');
  });

  it('still refuses a different session that is in force on the dates the change applies to, and names it', () => {
    const editing = rule({ id: 'now', startTime: '09:00', endTime: '10:00' });
    const live = rule({ id: 'other', startTime: '09:15', endTime: '09:45', effectiveFrom: '2030-01-14', effectiveTo: null }); // starts the week after the change
    expect(plan(editing, { startTime: '09:30', endTime: '10:00' }, { rules: [editing, live], applyFrom: MONDAY }).problems[0]).toMatch(/overlap another session \(09:15-09:45\)/);
    const earlier = rule({ id: 'earlier', startTime: '09:15', endTime: '09:45', effectiveTo: '2030-01-06' });
    expect(plan(editing, { startTime: '09:30', endTime: '10:00' }, { rules: [editing, earlier], applyFrom: NEXT_MONDAY }).problems).toEqual([]);
  });

  it('refuses hours that overlap another session of the same kind, but not back-to-back ones', () => {
    const afternoon = rule({ id: 'row-2', startTime: '13:00', endTime: '15:00' });
    expect(plan(rule(), { startTime: '10:00', endTime: '14:00' }, { rules: [rule(), afternoon] }).problems[0]).toMatch(/overlap another session \(13:00-15:00\)/);
    expect(plan(rule(), { startTime: '10:00', endTime: '13:00' }, { rules: [rule(), afternoon] }).problems).toEqual([]);
    // a session on another weekday or with other effective dates is no clash
    const ended = rule({ id: 'row-3', startTime: '12:00', endTime: '14:00', effectiveTo: '2029-12-31', effectiveFrom: '2029-01-01' });
    expect(plan(rule({ effectiveFrom: '2030-01-01' }), { startTime: '10:00', endTime: '13:00' }, { rules: [rule({ effectiveFrom: '2030-01-01' }), ended] }).problems).toEqual([]);
  });

  it('refuses an end before the start, hours shorter than a slot, and no change at all', () => {
    expect(plan(rule(), { startTime: '12:00', endTime: '10:00' }).problems[0]).toMatch(/end time must be after/);
    expect(plan(rule(), { startTime: '10:00', endTime: '10:20' }).problems.join(' ')).toMatch(/at least 30 minutes/);
    expect(plan(rule(), { startTime: '10:00', endTime: '12:00' }).kind).toBe('NONE');
  });
});

describe('isCovered', () => {
  it('is about the working hours, not the slot grid', () => {
    const { sessions } = slotsOn(MONDAY, [rule({ endTime: '11:00' })], null, DOCTOR);
    expect(isCovered(sessions, '10:00', '10:30')).toBe(true);
    expect(isCovered(sessions, '10:15', '10:45')).toBe(true); // off the grid, but inside the hours
    expect(isCovered(sessions, '11:00', '11:30')).toBe(false);
    expect(isCovered(sessions, '10:45', '11:15')).toBe(false); // runs past the end
  });

  it('treats a blocked time as outside the hours', () => {
    const block: DateOverride = { isAvailable: false, startTime: '10:30', endTime: '11:00', capacity: null, reason: null };
    const { sessions } = slotsOn(MONDAY, [rule()], block, DOCTOR);
    expect(isCovered(sessions, '10:00', '10:30')).toBe(true);
    expect(isCovered(sessions, '10:30', '11:00')).toBe(false);
  });
});

describe('findAffected', () => {
  const at = (id: string, date: string, startTime: string, endTime: string): Placed => ({ id, date, startTime, endTime });
  const reduce = (row: AvailabilityRule, to: { startTime: string; endTime: string }) => ({ ...row, ...to });

  it('flags exactly the appointments the reduced hours leave outside, for Stream and Wave', () => {
    for (const row of [rule(), wave()]) {
      const appointments = [at('early', MONDAY, '10:00', '10:30'), at('edge', MONDAY, '10:30', '11:00'), at('gone', MONDAY, '11:00', '11:30'), at('late', MONDAY, '11:30', '12:00')];
      const affected = findAffected({ appointments, rules: [row], afterRules: [reduce(row, { startTime: '10:00', endTime: '11:00' })], overrides: noOverrides, doctor: DOCTOR });
      expect(affected).toEqual(['gone', 'late']);
    }
  });

  it('flags the appointments before a later start, and none when the hours only grow', () => {
    const appointments = [at('first', MONDAY, '10:00', '10:30'), at('second', MONDAY, '10:30', '11:00')];
    expect(findAffected({ appointments, rules: [rule()], afterRules: [reduce(rule(), { startTime: '10:30', endTime: '12:00' })], overrides: noOverrides, doctor: DOCTOR })).toEqual(['first']);
    expect(findAffected({ appointments, rules: [rule()], afterRules: [reduce(rule(), { startTime: '09:00', endTime: '13:00' })], overrides: noOverrides, doctor: DOCTOR })).toEqual([]);
  });

  it('does not blame the change for an appointment that was already outside the hours', () => {
    const appointments = [at('stray', MONDAY, '15:00', '15:30'), at('real', MONDAY, '11:30', '12:00')];
    expect(findAffected({ appointments, rules: [rule()], afterRules: [reduce(rule(), { startTime: '10:00', endTime: '11:00' })], overrides: noOverrides, doctor: DOCTOR })).toEqual(['real']);
  });

  it('leaves a date with replacement hours or a day off alone, whatever the row does', () => {
    const overrides = new Map<string, DateOverride>([
      [MONDAY, { isAvailable: true, startTime: '11:00', endTime: '13:00', capacity: 4, reason: null }],
      [NEXT_MONDAY, { isAvailable: false, startTime: null, endTime: null, capacity: null, reason: 'Conference' }],
    ]);
    const appointments = [at('replaced', MONDAY, '12:00', '12:30'), at('dayoff', NEXT_MONDAY, '11:30', '12:00')];
    expect(findAffected({ appointments, rules: [rule()], afterRules: [reduce(rule(), { startTime: '10:00', endTime: '11:00' })], overrides, doctor: DOCTOR })).toEqual([]);
  });

  it('is about the hours, not the slot grid: an appointment off the grid but still inside the hours is not flagged', () => {
    const appointments = [at('offgrid', MONDAY, '10:15', '10:45')];
    expect(findAffected({ appointments, rules: [rule()], afterRules: [reduce(rule(), { startTime: '10:00', endTime: '11:00' })], overrides: noOverrides, doctor: DOCTOR })).toEqual([]);
  });

  it('only reaches the row that changed: other sessions keep covering their own appointments', () => {
    const afternoon = rule({ id: 'row-2', startTime: '14:00', endTime: '16:00' });
    const appointments = [at('pm', MONDAY, '14:30', '15:00'), at('am', MONDAY, '11:00', '11:30')];
    const affected = findAffected({ appointments, rules: [rule(), afternoon], afterRules: [reduce(rule(), { startTime: '10:00', endTime: '11:00' }), afternoon], overrides: noOverrides, doctor: DOCTOR });
    expect(affected).toEqual(['am']);
  });
});

describe('findRestored', () => {
  const at = (id: string, date: string, startTime: string, endTime: string): Placed => ({ id, date, startTime, endTime });
  const reduced = rule({ endTime: '11:00' });
  const widen = (to: { startTime: string; endTime: string }) => ({ ...reduced, ...to });
  const args = (appointments: Placed[], to: { startTime: string; endTime: string }, overrides = noOverrides, rules = [reduced], afterRules = [widen(to)]) => ({ appointments, rules, afterRules, overrides, doctor: DOCTOR });

  it('returns exactly the appointments that were outside the hours and are inside the wider ones', () => {
    const appointments = [at('inside', MONDAY, '10:30', '11:00'), at('back', MONDAY, '11:00', '11:30'), at('still', MONDAY, '11:30', '12:00')];
    expect(findRestored(args(appointments, { startTime: '10:00', endTime: '11:30' }))).toEqual(['back']); // partial: the 11:30 one stays outside
    expect(findRestored(args(appointments, { startTime: '10:00', endTime: '12:00' }))).toEqual(['back', 'still']);
  });

  it('works when the start moves earlier', () => {
    const appointments = [at('early', MONDAY, '09:00', '09:30'), at('tooearly', MONDAY, '08:00', '08:30')];
    expect(findRestored(args(appointments, { startTime: '09:00', endTime: '11:00' }))).toEqual(['early']);
  });

  it('returns nothing when the hours only shrink or stay the same', () => {
    const appointments = [at('a', MONDAY, '11:00', '11:30')];
    expect(findRestored(args(appointments, { startTime: '10:00', endTime: '10:30' }))).toEqual([]);
    expect(findRestored(args(appointments, { startTime: '10:00', endTime: '11:00' }))).toEqual([]);
  });

  it('does not release anyone on a day off, a blocked time, or a date whose replacement hours do not reach them', () => {
    const appointments = [at('dayoff', MONDAY, '11:00', '11:30'), at('blocked', NEXT_MONDAY, '11:00', '11:30'), at('replaced', '2030-01-15', '11:00', '11:30')];
    const overrides = new Map<string, DateOverride>([
      [MONDAY, { isAvailable: false, startTime: null, endTime: null, capacity: null, reason: 'Away' }],
      [NEXT_MONDAY, { isAvailable: false, startTime: '11:00', endTime: '11:30', capacity: null, reason: null }],
      ['2030-01-15', { isAvailable: true, startTime: '13:00', endTime: '14:00', capacity: 4, reason: null }],
    ]);
    expect(findRestored(args(appointments, { startTime: '10:00', endTime: '12:00' }, overrides))).toEqual([]);
  });

  it('is not fooled by another session: only the row that changed can release an appointment, and only if it now covers it', () => {
    const afternoon = rule({ id: 'row-2', startTime: '14:00', endTime: '16:00' });
    const appointments = [at('pm', MONDAY, '14:30', '15:00'), at('am', MONDAY, '11:00', '11:30'), at('gap', MONDAY, '12:30', '13:00')];
    expect(findRestored(args(appointments, { startTime: '10:00', endTime: '12:00' }, noOverrides, [reduced, afternoon], [widen({ startTime: '10:00', endTime: '12:00' }), afternoon]))).toEqual(['am']);
  });

  it('is the mirror of findAffected: whatever a reduction strands, the matching extension restores', () => {
    const row = rule();
    const smaller = { ...row, endTime: '11:00' };
    const appointments = [at('a', MONDAY, '10:00', '10:30'), at('b', MONDAY, '11:00', '11:30'), at('c', MONDAY, '11:30', '12:00')];
    const stranded = findAffected({ appointments, rules: [row], afterRules: [smaller], overrides: noOverrides, doctor: DOCTOR });
    expect(findRestored({ appointments, rules: [smaller], afterRules: [row], overrides: noOverrides, doctor: DOCTOR })).toEqual(stranded);
  });
});

describe('openSlotsOn', () => {
  it('lists the slots that can still be booked, with the places left, and drops full, booked and past ones', () => {
    const row = wave({ endTime: '11:30' }); // 10:00, 10:30, 11:00; three places each
    const booked = [
      { startTime: '10:00', endTime: '10:30', slotNumber: 1 },
      { startTime: '10:00', endTime: '10:30', slotNumber: 2 },
      { startTime: '10:00', endTime: '10:30', slotNumber: 3 }, // full
      { startTime: '10:30', endTime: '11:00', slotNumber: 1 },
    ];
    const open = openSlotsOn(MONDAY, [row], null, DOCTOR, booked, null);
    expect(open.map((slot) => [slot.startTime, slot.remaining])).toEqual([['10:30', 2], ['11:00', 3]]);
    expect(openSlotsOn(MONDAY, [row], null, DOCTOR, [], '10:40').map((slot) => slot.startTime)).toEqual(['11:00']); // 10:00 and 10:30 have started
  });

  it('is empty on a day off', () => {
    const dayOff = new Map<string, DateOverride>([[MONDAY, { isAvailable: false, startTime: null, endTime: null, capacity: null, reason: null }]]);
    expect(openSlotsOn(MONDAY, [rule()], dayOff.get(MONDAY) ?? null, DOCTOR, [], null)).toEqual([]);
  });
});
