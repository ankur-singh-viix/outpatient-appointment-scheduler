-- Durable record of "the doctor reduced their hours" and of each booked appointment it left outside them. Additive: two new tables
-- and indexes only. Nothing existing is altered, so it is safe to apply on a live database and old code ignores it.
--
--  * schedule_changes: one row per applied change of an availability row's hours (what changed, from when, by whom). The audit trail.
--  * schedule_change_appointments: one row per appointment a reduction left outside the hours. It remembers whether the patient has
--    been told yet (notified_at, set by the background notifier, not inside the doctor's request) and how it was settled
--    (RESCHEDULED, CANCELLED, COVERED when the hours were later widened again, or CLOSED for any other end such as completed). The appointment itself keeps its status
--    (PENDING/CONFIRMED) and all payment data; this table only follows it until somebody resolves it.

CREATE TABLE schedule_changes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id          uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  availability_id    uuid REFERENCES availability(id) ON DELETE SET NULL,
  kind               varchar(10) NOT NULL CHECK (kind IN ('EXPAND', 'SHRINK', 'MIXED')),
  apply_from         date NOT NULL,
  old_start_time     time NOT NULL,
  old_end_time       time NOT NULL,
  new_start_time     time NOT NULL,
  new_end_time       time NOT NULL,
  affected_count     integer NOT NULL DEFAULT 0 CHECK (affected_count >= 0),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedule_changes_doctor ON schedule_changes (doctor_id, created_at DESC);

CREATE TABLE schedule_change_appointments (
  change_id      uuid NOT NULL REFERENCES schedule_changes(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  notified_at    timestamptz,
  resolved_at    timestamptz,
  -- A time the doctor suggested for this patient (one of the open times the preview offered), shown in the email.
  proposed_date  date,
  proposed_start_time time,
  proposed_end_time   time,
  -- Failed attempts to queue the notice; the notifier gives up after a few and leaves the row visible (the doctor can ask again).
  attempts       smallint NOT NULL DEFAULT 0,
  resolution     varchar(12) CHECK (resolution IN ('RESCHEDULED', 'CANCELLED', 'COVERED', 'CLOSED')),
  PRIMARY KEY (change_id, appointment_id),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

-- The notifier's queue: only rows nobody has told yet and nobody has resolved. Stays tiny however many changes are in history.
CREATE INDEX idx_sca_pending_notice ON schedule_change_appointments (created_at) WHERE notified_at IS NULL AND resolved_at IS NULL;

-- Resolution hooks (cancel, reschedule) find the open rows of one appointment.
CREATE INDEX idx_sca_open_by_appointment ON schedule_change_appointments (appointment_id) WHERE resolved_at IS NULL;
