-- Initial schema, implementing docs/er-diagram.md.
-- Addition to the diagram: doctors.consultation_fee (shown in the doctor directory).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on PostgreSQL < 13

CREATE TYPE user_role AS ENUM ('PATIENT', 'DOCTOR', 'RECEPTIONIST', 'ADMIN');
CREATE TYPE scheduling_mode AS ENUM ('STREAM', 'WAVE');
CREATE TYPE appointment_status AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(120) NOT NULL,
  email         varchar(255) NOT NULL,
  password_hash varchar(255),
  google_id     varchar(255),
  role          user_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT uq_users_google_id UNIQUE (google_id)
);

CREATE TABLE clinics (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       varchar(160) NOT NULL,
  address    text NOT NULL,
  phone      varchar(32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE specialties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(120) NOT NULL,
  description text,
  CONSTRAINT uq_specialties_name UNIQUE (name)
);

CREATE TABLE patients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  phone         varchar(32),
  date_of_birth date,
  gender        varchar(32),
  address       text,
  CONSTRAINT uq_patients_user UNIQUE (user_id)
);

CREATE TABLE doctors (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  clinic_id              uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  specialty_id           uuid NOT NULL REFERENCES specialties(id) ON DELETE RESTRICT,
  consultation_minutes   integer NOT NULL DEFAULT 15,
  default_daily_capacity integer NOT NULL DEFAULT 20,
  consultation_fee       integer NOT NULL DEFAULT 0,
  bio                    text,
  CONSTRAINT uq_doctors_user UNIQUE (user_id),
  CONSTRAINT ck_doctor_consultation CHECK (consultation_minutes > 0),
  CONSTRAINT ck_doctor_capacity CHECK (default_daily_capacity > 0),
  CONSTRAINT ck_doctor_fee CHECK (consultation_fee >= 0)
);

CREATE TABLE receptionist_assignments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receptionist_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id            uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_receptionist_clinic UNIQUE (receptionist_user_id, clinic_id)
);

CREATE TABLE availability (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  day_of_week     smallint NOT NULL,
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  capacity        integer NOT NULL,
  scheduling_mode scheduling_mode NOT NULL DEFAULT 'STREAM',
  CONSTRAINT ck_availability_day CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT ck_availability_time CHECK (end_time > start_time),
  CONSTRAINT ck_availability_capacity CHECK (capacity > 0)
);
CREATE INDEX ix_availability_doctor_day ON availability (doctor_id, day_of_week);

CREATE TABLE schedule_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id     uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  override_date date NOT NULL,
  is_available  boolean NOT NULL,
  start_time    time,
  end_time      time,
  capacity      integer,
  reason        text,
  CONSTRAINT uq_override_doctor_date UNIQUE (doctor_id, override_date),
  CONSTRAINT ck_override_window CHECK (
    is_available = false
    OR (start_time IS NOT NULL AND end_time IS NOT NULL
        AND end_time > start_time
        AND capacity IS NOT NULL AND capacity > 0)
  )
);

CREATE TABLE appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  doctor_id         uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  booked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  appointment_date  date NOT NULL,
  start_time        time NOT NULL,
  end_time          time NOT NULL,
  status            appointment_status NOT NULL DEFAULT 'CONFIRMED',
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_appointment_time CHECK (end_time > start_time)
);

-- Double-booking backstop: one active appointment per doctor per start time.
CREATE UNIQUE INDEX uq_active_doctor_appointment_start
  ON appointments (doctor_id, appointment_date, start_time)
  WHERE status IN ('PENDING', 'CONFIRMED');

CREATE INDEX ix_appointments_patient ON appointments (patient_id, appointment_date);
