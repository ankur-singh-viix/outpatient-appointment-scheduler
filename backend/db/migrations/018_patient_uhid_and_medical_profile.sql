-- Permanent patient UHID + medical profile fields + medical update history.
--
-- Additive only:
--  - patients.uhid (unique, human-readable CC-UHID-000001), backfilled for existing rows
--  - medical profile columns on patients (nullable text / blood group)
--  - patient_medical_profile_history for field-level change audit
-- Phone stays non-unique (families may share a number). Account (users) stays separate from patient identity.
--
-- Production deploy order (required):
--  1. Take a database backup.
--  2. Apply this migration (018) and verify uhid, patient_uhid_seq, uq_patients_uhid, and backfill.
--  3. Deploy the new backend only after the migration succeeds.
-- See docs/patient-uhid-migration.md.
--
-- Forward-only in production: do not manually DROP medical history, UHID columns, or the sequence to "roll back".
-- Restore from the pre-migration backup if you must revert.
--
-- Note: backfilled UHID numbers are unique and permanent but are not guaranteed to match registration chronology.
-- Values above 999999 stay unique (padding widens; varchar(32) still fits).

CREATE SEQUENCE IF NOT EXISTS patient_uhid_seq START WITH 1 INCREMENT BY 1;

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS uhid varchar(32),
  ADD COLUMN IF NOT EXISTS blood_group varchar(8),
  ADD COLUMN IF NOT EXISTS allergies text,
  ADD COLUMN IF NOT EXISTS sensitivities text,
  ADD COLUMN IF NOT EXISTS medical_conditions text,
  ADD COLUMN IF NOT EXISTS current_medications text,
  ADD COLUMN IF NOT EXISTS previous_surgeries text,
  ADD COLUMN IF NOT EXISTS other_medical_info text;

-- Backfill UHID for existing patients in stable account-creation order. Only rows still missing a UHID.
WITH numbered AS (
  SELECT p.id,
         nextval('patient_uhid_seq') AS n
    FROM patients p
    JOIN users u ON u.id = p.user_id
   WHERE p.uhid IS NULL
   ORDER BY u.created_at ASC, p.id ASC
)
UPDATE patients AS p
   SET uhid = 'CC-UHID-' || lpad(numbered.n::text, 6, '0')
  FROM numbered
 WHERE p.id = numbered.id;

-- Any remaining nulls (edge cases without a user join) still get a number.
UPDATE patients
   SET uhid = 'CC-UHID-' || lpad(nextval('patient_uhid_seq')::text, 6, '0')
 WHERE uhid IS NULL;

ALTER TABLE patients
  ALTER COLUMN uhid SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_patients_uhid'
  ) THEN
    ALTER TABLE patients ADD CONSTRAINT uq_patients_uhid UNIQUE (uhid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_patients_blood_group'
  ) THEN
    ALTER TABLE patients ADD CONSTRAINT ck_patients_blood_group CHECK (
      blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')
    );
  END IF;
END $$;

-- New patient rows without an explicit UHID receive the next sequence value atomically.
CREATE OR REPLACE FUNCTION allocate_patient_uhid() RETURNS trigger AS $$
BEGIN
  IF NEW.uhid IS NULL OR btrim(NEW.uhid) = '' THEN
    NEW.uhid := 'CC-UHID-' || lpad(nextval('patient_uhid_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patients_allocate_uhid ON patients;
CREATE TRIGGER trg_patients_allocate_uhid
  BEFORE INSERT ON patients
  FOR EACH ROW
  EXECUTE PROCEDURE allocate_patient_uhid();

CREATE TABLE IF NOT EXISTS patient_medical_profile_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  field_name         varchar(64) NOT NULL,
  previous_value     text,
  new_value          text,
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_patient_medical_history_patient
  ON patient_medical_profile_history (patient_id, updated_at DESC);
