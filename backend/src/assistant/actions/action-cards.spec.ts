import { describe, expect, it } from 'vitest';
import { dateLabel, rangeLabel, rupees, timeLabel } from './action-cards.js';

describe('action card wording', () => {
  it('writes times the way patients read them', () => {
    expect(timeLabel('00:00')).toBe('12:00 AM');
    expect(timeLabel('09:30')).toBe('9:30 AM');
    expect(timeLabel('12:00')).toBe('12:00 PM');
    expect(timeLabel('13:05')).toBe('1:05 PM');
    expect(rangeLabel('09:00', '09:30')).toBe('9:00 AM – 9:30 AM');
  });

  it('writes dates with the weekday and year, whatever the server time zone', () => {
    expect(dateLabel('2026-11-13')).toBe('Fri, 13 Nov 2026');
    expect(dateLabel('2027-01-01')).toBe('Fri, 1 Jan 2027');
  });

  it('writes money from paise without inventing digits', () => {
    expect(rupees(65_000)).toBe('Rs. 650');
    expect(rupees(32_500)).toBe('Rs. 325');
    expect(rupees(32_550)).toBe('Rs. 325.50');
    expect(rupees(1)).toBe('Rs. 0.01');
  });
});
