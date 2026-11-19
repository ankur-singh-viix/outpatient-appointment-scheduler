import { describe, expect, it } from 'vitest';
import { medicalProfileChanges, normalizeMedicalText } from './medical-profile-diff.js';

const empty = {
  bloodGroup: null,
  allergies: null,
  sensitivities: null,
  medicalConditions: null,
  currentMedications: null,
  previousSurgeries: null,
  otherMedicalInfo: null,
};

describe('medicalProfileChanges', () => {
  it('records only fields that change and ignores whitespace-only clears that stay empty', () => {
    expect(
      medicalProfileChanges(
        { ...empty, allergies: 'Penicillin', bloodGroup: 'A+' },
        { allergies: 'Peanuts', bloodGroup: 'A+', sensitivities: '  ' },
      ),
    ).toEqual([{ fieldName: 'allergies', previousValue: 'Penicillin', newValue: 'Peanuts' }]);
  });

  it('treats clearing a value as a real change', () => {
    expect(medicalProfileChanges({ ...empty, allergies: 'Dust' }, { allergies: null })).toEqual([
      { fieldName: 'allergies', previousValue: 'Dust', newValue: null },
    ]);
    expect(normalizeMedicalText('  ')).toBeNull();
  });
});
