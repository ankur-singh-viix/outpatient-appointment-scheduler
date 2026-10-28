-- Cancellation and rescheduling support.
--  * cancelled_at:         when a cancelled appointment was cancelled.
--  * rescheduled_from_id:  set on the NEW appointment created by a reschedule, pointing at the one it replaced
--                          (which is kept, with status CANCELLED, as history).
-- Cancelled appointments already stop occupying slots: the double-booking index only covers PENDING/CONFIRMED rows.

ALTER TABLE appointments
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN rescheduled_from_id uuid REFERENCES appointments(id) ON DELETE SET NULL;

-- Any appointment cancelled before this column existed gets a timestamp so the constraint below can hold.
UPDATE appointments SET cancelled_at = updated_at WHERE status = 'CANCELLED' AND cancelled_at IS NULL;

ALTER TABLE appointments
  ADD CONSTRAINT ck_appointment_cancelled_at CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL);

CREATE INDEX ix_appointments_rescheduled_from ON appointments (rescheduled_from_id)
  WHERE rescheduled_from_id IS NOT NULL;
