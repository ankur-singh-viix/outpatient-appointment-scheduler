-- Patient medical reports metadata (binaries live in private S3-compatible object storage).
-- Additive only. No appointment FK: reports belong to the permanent patient / UHID identity.
--
-- Apply safely: take a DB backup, run migration 019, then deploy the backend that expects this table.
-- Forward-only in production; restore from backup to revert.

CREATE TYPE medical_report_category AS ENUM (
  'BLOOD_TESTS',
  'X_RAY',
  'CT_SCAN',
  'MRI',
  'ULTRASOUND',
  'ECG_CARDIAC',
  'OTHER'
);

CREATE TYPE medical_report_uploader_role AS ENUM ('PATIENT', 'RECEPTIONIST');

CREATE TABLE patient_medical_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  patient_uhid        varchar(32) NOT NULL,
  category            medical_report_category NOT NULL,
  report_date         date NOT NULL,
  original_filename   varchar(255) NOT NULL,
  content_type        varchar(100) NOT NULL,
  byte_size           integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  storage_key         varchar(512) NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_by_role    medical_report_uploader_role NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_medical_reports_storage_key UNIQUE (storage_key)
);

CREATE INDEX idx_medical_reports_patient_date
  ON patient_medical_reports (patient_id, report_date DESC, created_at DESC);
