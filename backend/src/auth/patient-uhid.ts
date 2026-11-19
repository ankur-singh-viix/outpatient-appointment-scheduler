import type { EntityManager } from 'typeorm';

/** Human-readable permanent hospital ID, e.g. CC-UHID-000001. */
export function formatPatientUhid(sequenceValue: number): string {
  if (!Number.isInteger(sequenceValue) || sequenceValue < 1) {
    throw new Error('UHID sequence value must be a positive integer.');
  }
  return `CC-UHID-${String(sequenceValue).padStart(6, '0')}`;
}

/**
 * Allocates the next UHID from patient_uhid_seq inside the caller's transaction.
 * The unique constraint on patients.uhid is the database backstop against duplicates.
 */
export async function allocatePatientUhid(manager: EntityManager): Promise<string> {
  const rows: { n: string | number }[] = await manager.query(`SELECT nextval('patient_uhid_seq') AS n`);
  return formatPatientUhid(Number(rows[0]?.n));
}

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/** Medical profile fields patients may edit. Keys match patients columns / history field_name. */
export const MEDICAL_PROFILE_FIELDS = [
  'bloodGroup',
  'allergies',
  'sensitivities',
  'medicalConditions',
  'currentMedications',
  'previousSurgeries',
  'otherMedicalInfo',
] as const;

export type MedicalProfileField = (typeof MEDICAL_PROFILE_FIELDS)[number];
