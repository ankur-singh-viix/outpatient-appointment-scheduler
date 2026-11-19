import { MEDICAL_PROFILE_FIELDS, type MedicalProfileField } from './patient-uhid.js';

export type MedicalValues = Record<MedicalProfileField, string | null>;

export interface MedicalFieldChange {
  fieldName: MedicalProfileField;
  previousValue: string | null;
  newValue: string | null;
}

export function normalizeMedicalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Builds append-only history rows for fields that actually changed. */
export function medicalProfileChanges(
  current: MedicalValues,
  patch: Partial<MedicalValues>,
): MedicalFieldChange[] {
  const changes: MedicalFieldChange[] = [];
  for (const field of MEDICAL_PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const previousValue = normalizeMedicalText(current[field]);
    const newValue = normalizeMedicalText(patch[field] ?? null);
    if (previousValue === newValue) continue;
    changes.push({ fieldName: field, previousValue, newValue });
  }
  return changes;
}
