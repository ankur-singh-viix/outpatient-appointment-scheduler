-- Configurable slot interval, and a database guard against overlapping appointments. Additive and backward compatible.
--
--  * doctors.slot_interval_minutes: how often a new bookable slot STARTS. NULL (every existing doctor) means "same as the
--    appointment length", which is exactly how slots have always worked, so nothing changes until a doctor sets it. With a
--    30-minute appointment and a 15-minute interval the slots overlap: 11:00-11:30, 11:15-11:45, 11:30-12:00, ...
--  * appointments already store both start_time and end_time, so no column is added there.
--  * ex_appointments_no_overlap: no two ACTIVE (PENDING/CONFIRMED) appointments for one doctor may share any time. The booking
--    code already refuses overlaps under the doctor's row lock; this is the backstop that holds even if that code is bypassed.
--    Back-to-back appointments (one ending when the next starts) are fine.
--
-- The constraint is added only when it is safe to. If existing data already has overlapping active appointments, or the
-- btree_gist extension cannot be created, it is skipped with a NOTICE in the migration log and the migration still succeeds:
-- a deployment must never fail on old data. The booking code enforces the rule either way.

ALTER TABLE doctors ADD COLUMN slot_interval_minutes integer;
ALTER TABLE doctors ADD CONSTRAINT ck_doctor_slot_interval CHECK (slot_interval_minutes IS NULL OR slot_interval_minutes > 0);

DO $$
DECLARE
  overlapping integer;
BEGIN
  SELECT count(*) INTO overlapping
    FROM appointments a
    JOIN appointments b
      ON a.id < b.id
     AND a.doctor_id = b.doctor_id
     AND a.appointment_date = b.appointment_date
     AND a.status IN ('PENDING', 'CONFIRMED')
     AND b.status IN ('PENDING', 'CONFIRMED')
     AND a.start_time < b.end_time
     AND b.start_time < a.end_time;

  IF overlapping > 0 THEN
    RAISE NOTICE 'ex_appointments_no_overlap NOT added: % pair(s) of active appointments already overlap. Resolve them, then add the constraint by hand. The booking code still refuses new overlaps.', overlapping;
    RETURN;
  END IF;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    ALTER TABLE appointments
      ADD CONSTRAINT ex_appointments_no_overlap
      EXCLUDE USING gist (
        doctor_id WITH =,
        tsrange(appointment_date + start_time, appointment_date + end_time, '[)') WITH &&
      ) WHERE (status IN ('PENDING', 'CONFIRMED'));
  EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
    RAISE NOTICE 'ex_appointments_no_overlap NOT added: the btree_gist extension is unavailable here. The booking code still refuses overlaps.';
  END;
END $$;
