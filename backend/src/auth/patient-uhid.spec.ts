import { describe, expect, it } from 'vitest';
import { formatPatientUhid } from './patient-uhid.js';

describe('formatPatientUhid', () => {
  it('formats the CareSlot UHID with a zero-padded sequence', () => {
    expect(formatPatientUhid(1)).toBe('CC-UHID-000001');
    expect(formatPatientUhid(12)).toBe('CC-UHID-000012');
    expect(formatPatientUhid(999999)).toBe('CC-UHID-999999');
  });

  it('rejects non-positive sequence values', () => {
    expect(() => formatPatientUhid(0)).toThrow(/positive/);
    expect(() => formatPatientUhid(-1)).toThrow(/positive/);
    expect(() => formatPatientUhid(1.5)).toThrow(/positive/);
  });
});
