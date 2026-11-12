-- AI assistant, phase 2: actions a patient asks the assistant to prepare (book, move, cancel) and then confirms with a button.
--
-- Why a table: a confirmation must be SINGLE-USE and survive a restart or a second server. The prepared action is stored here, exactly
-- as it was shown to the patient, and the confirm button can only ever run what is stored (never what the browser or the model says).
-- The status change PREPARED -> CONFIRMING is one atomic UPDATE, so two clicks, two tabs or a replay can never run an action twice.
-- It also keeps a plain record of what the assistant was asked to do on a patient's behalf and how it ended. Additive: no existing table
-- changes, and nothing here is read by booking, payments or scheduling.

CREATE TABLE assistant_actions (
  -- The confirmation reference the browser holds. Random and unguessable, and only ever honoured for the user it was made for.
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                  varchar(12) NOT NULL CHECK (kind IN ('BOOK', 'RESCHEDULE', 'CANCEL')),
  -- Exactly what was prepared: {doctorId, date, startTime} / {appointmentId, date, startTime} / {appointmentId}.
  params                jsonb NOT NULL,
  status                varchar(10) NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED', 'CONFIRMING', 'DONE', 'FAILED', 'DISMISSED')),
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- When the patient confirmed or dismissed it.
  decided_at            timestamptz,
  -- The appointment the action produced (the new booking, or the new time), when it succeeded.
  result_appointment_id uuid,
  -- Why it failed, in the words shown to the patient. Never a stack trace.
  failure               text,
  CHECK ((status IN ('PREPARED')) = (decided_at IS NULL))
);

CREATE INDEX idx_assistant_actions_user ON assistant_actions (user_id, created_at DESC);
