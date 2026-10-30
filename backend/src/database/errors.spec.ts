import { QueryFailedError } from 'typeorm';
import { isSlotConflict, isUniqueViolation } from './errors.js';

const failed = (code: string | undefined) => new QueryFailedError('INSERT ...', [], Object.assign(new Error('db error'), { code }));

describe('database error helpers', () => {
  it('recognises a unique violation (an exact start time already used)', () => {
    expect(isUniqueViolation(failed('23505'))).toBe(true);
    expect(isSlotConflict(failed('23505'))).toBe(true);
  });

  it('recognises an exclusion violation (an overlapping appointment) as a slot conflict, but not as a unique violation', () => {
    expect(isSlotConflict(failed('23P01'))).toBe(true);
    expect(isUniqueViolation(failed('23P01'))).toBe(false);
  });

  it('does not treat other database errors, or non-database errors, as a slot conflict', () => {
    for (const other of [failed('23503'), failed('42P01'), failed(undefined), new Error('boom'), null, undefined, 'text']) {
      expect(isSlotConflict(other)).toBe(false);
    }
  });
});
