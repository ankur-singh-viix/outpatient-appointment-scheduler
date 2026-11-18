-- Queue management: a doctor-wise queue for patients who have arrived (checked in) for a CONFIRMED appointment.
--
-- Additive only: two new tables, nothing existing changes. It does not depend on migrations 012-014 (it references only users, doctors,
-- patients and appointments from migration 001), so it can be renumbered if it lands on a branch with a different migration history.
-- To undo it (nothing else reads these tables): DROP TABLE queue_events; DROP TABLE queue_entries;
--
-- An appointment never gets a new status because of the queue. The queue is a separate record of "who is waiting for which doctor
-- today, in what order": the appointment stays CONFIRMED until the doctor completes the consultation (CONFIRMED -> COMPLETED, the
-- transition the appointment lifecycle already has). A cancelled appointment is not rewritten here: it is simply no longer counted
-- (the queue joins the appointment's own status), so the existing cancel and reschedule flows are untouched.

CREATE TABLE IF NOT EXISTS queue_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One entry per appointment: a second check-in for the same appointment is refused by the database as well as by the code.
  appointment_id        uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  doctor_id             uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  patient_id            uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  -- The clinic-local day this queue belongs to (the appointment's own date). Tokens start again at 1 every day, per doctor.
  queue_date            date NOT NULL,
  token_number          integer NOT NULL CHECK (token_number > 0),
  status                varchar(12) NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'SERVING', 'COMPLETED', 'CHECKED_OUT', 'SKIPPED', 'CANCELLED')),
  checked_in_at         timestamptz NOT NULL DEFAULT now(),
  checked_in_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  called_at             timestamptz,
  called_by_user_id     uuid REFERENCES users(id) ON DELETE RESTRICT,
  completed_at          timestamptz,
  completed_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  checked_out_at        timestamptz,
  checked_out_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  skipped_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_queue_entries_appointment UNIQUE (appointment_id),
  -- Tokens are unique within one doctor's queue for one day, and a token is never reused that day (cancelled ones keep theirs).
  CONSTRAINT uq_queue_entries_token UNIQUE (doctor_id, queue_date, token_number),
  CONSTRAINT ck_queue_called CHECK (status NOT IN ('SERVING', 'COMPLETED', 'CHECKED_OUT') OR called_at IS NOT NULL),
  CONSTRAINT ck_queue_completed CHECK (status NOT IN ('COMPLETED', 'CHECKED_OUT') OR completed_at IS NOT NULL),
  CONSTRAINT ck_queue_checked_out CHECK (status <> 'CHECKED_OUT' OR checked_out_at IS NOT NULL)
);

-- A doctor is serving at most one patient at a time: the database refuses a second SERVING entry for the same doctor and day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_one_serving ON queue_entries (doctor_id, queue_date) WHERE status = 'SERVING';
CREATE INDEX IF NOT EXISTS ix_queue_doctor_day ON queue_entries (doctor_id, queue_date, token_number);
CREATE INDEX IF NOT EXISTS ix_queue_patient_day ON queue_entries (patient_id, queue_date);

-- Every change of a queue entry, who made it and when. Append only.
CREATE TABLE IF NOT EXISTS queue_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id      uuid NOT NULL REFERENCES queue_entries(id) ON DELETE CASCADE,
  event         varchar(16) NOT NULL CHECK (event IN ('CHECKED_IN', 'CALLED', 'COMPLETED', 'CHECKED_OUT', 'SKIPPED', 'RETURNED', 'CANCELLED')),
  from_status   varchar(12),
  to_status     varchar(12) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_queue_events_entry ON queue_events (entry_id, id);
