-- Doctor-assigned receptionists and prescriptions.
--
-- Additive only: two new tables. Existing receptionist_assignments (clinic) stay as the admin link; a doctor then chooses one
-- receptionist from their clinic. Receptionists may manage only the doctors who assigned them. Prescriptions are drafted and
-- finalized by the doctor; receptionists may view and print finalized ones only.
-- To undo: DROP TABLE prescriptions; DROP TABLE doctor_receptionist_assignments;

-- One receptionist per doctor (assign / change replaces the row; remove deletes it). A receptionist may work for several doctors.
CREATE TABLE IF NOT EXISTS doctor_receptionist_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id             uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  receptionist_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_doctor_receptionist_doctor UNIQUE (doctor_id)
);

CREATE INDEX IF NOT EXISTS ix_doctor_receptionist_user ON doctor_receptionist_assignments (receptionist_user_id);

CREATE TABLE IF NOT EXISTS prescriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id          uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  doctor_id               uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  patient_id              uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  status                  varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINALIZED')),
  diagnosis               text,
  notes                   text,
  -- [{ "name", "dosage", "frequency", "duration", "instructions" }]
  medications             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  finalized_at            timestamptz,
  finalized_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_prescriptions_appointment UNIQUE (appointment_id),
  CONSTRAINT ck_prescription_finalized CHECK (
    (status = 'DRAFT' AND finalized_at IS NULL AND finalized_by_user_id IS NULL)
    OR (status = 'FINALIZED' AND finalized_at IS NOT NULL AND finalized_by_user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_prescriptions_doctor ON prescriptions (doctor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_prescriptions_patient ON prescriptions (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_prescriptions_status ON prescriptions (status, doctor_id);
