-- Wave and stream scheduling. Additive and backward compatible: every existing row keeps its meaning, and code that does not know
-- about the new columns keeps working because each one has a safe default.
--
-- availability
--   * recurrence_type WEEKLY (repeats on day_of_week) or ONE_TIME (applies on specific_date). Every existing row is WEEKLY.
--   * slot_duration_minutes: the length of each generated slot. Backfilled from the doctor's consultation length. NULL still
--     means "the doctor's length", so inserts that predate this migration keep working.
--   * capacity_per_slot: how many patients one slot takes. STREAM is always 1 (a CHECK enforces it); WAVE is 1 or more.
--   * effective_from / effective_to: optional date range in which the row applies.
--   * day_of_week and capacity become nullable (a ONE_TIME row has no weekday; WAVE needs no session-wide cap). The existing
--     CHECKs still hold, because a CHECK passes on NULL. `capacity` keeps its old meaning for STREAM: a cap on bookings per session.
--
-- appointments
--   * availability_id: the availability row the slot came from (best effort for old data, see the backfill). ON DELETE SET NULL,
--     so replacing availability never deletes or invalidates an appointment.
--   * slot_capacity / slot_number: how many patients the slot takes, and which seat this appointment holds (1..slot_capacity).
--     Existing appointments are 1 of 1. The unique index and the exclusion constraint now work per seat, so a WAVE slot can hold
--     several patients while a STREAM slot (always seat 1) still holds exactly one.
--
-- schedule_overrides
--   * An UNAVAILABLE override may now carry a start and end time, to block only that part of the day. Without times it blocks the
--     whole day, as before.
--
-- Rollback (nothing else depends on these objects):
--   DROP INDEX uq_active_slot_seat;
--   CREATE UNIQUE INDEX uq_active_doctor_appointment_start ON appointments (doctor_id, appointment_date, start_time) WHERE status IN ('PENDING','CONFIRMED');
--   (if ex_appointments_no_overlap exists: drop it and re-add it without slot_number, as in 007)
--   ALTER TABLE appointments DROP COLUMN availability_id, DROP COLUMN slot_capacity, DROP COLUMN slot_number;
--   ALTER TABLE schedule_overrides DROP CONSTRAINT ck_override_block_window;
--   DELETE FROM availability WHERE recurrence_type = 'ONE_TIME';
--   ALTER TABLE availability DROP COLUMN recurrence_type, DROP COLUMN specific_date, DROP COLUMN slot_duration_minutes,
--     DROP COLUMN capacity_per_slot, DROP COLUMN effective_from, DROP COLUMN effective_to;
--   ALTER TABLE availability ALTER COLUMN day_of_week SET NOT NULL, ALTER COLUMN capacity SET NOT NULL;   -- only if no NULLs remain
--   DROP TYPE recurrence_type;

CREATE TYPE recurrence_type AS ENUM ('WEEKLY', 'ONE_TIME');

ALTER TABLE availability
  ADD COLUMN recurrence_type      recurrence_type NOT NULL DEFAULT 'WEEKLY',
  ADD COLUMN specific_date        date,
  ADD COLUMN slot_duration_minutes integer,
  ADD COLUMN capacity_per_slot    integer NOT NULL DEFAULT 1,
  ADD COLUMN effective_from       date,
  ADD COLUMN effective_to         date;

ALTER TABLE availability ALTER COLUMN day_of_week DROP NOT NULL;
ALTER TABLE availability ALTER COLUMN capacity DROP NOT NULL;

UPDATE availability a SET slot_duration_minutes = d.consultation_minutes FROM doctors d WHERE d.id = a.doctor_id;

ALTER TABLE availability
  ADD CONSTRAINT ck_availability_recurrence CHECK (
    (recurrence_type = 'WEEKLY'   AND day_of_week IS NOT NULL AND specific_date IS NULL)
    OR (recurrence_type = 'ONE_TIME' AND specific_date IS NOT NULL AND day_of_week IS NULL)
  ),
  ADD CONSTRAINT ck_availability_slot_duration CHECK (slot_duration_minutes IS NULL OR slot_duration_minutes > 0),
  ADD CONSTRAINT ck_availability_capacity_per_slot CHECK (capacity_per_slot > 0),
  ADD CONSTRAINT ck_availability_stream_capacity CHECK (scheduling_mode = 'WAVE' OR capacity_per_slot = 1),
  ADD CONSTRAINT ck_availability_effective CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from);

CREATE INDEX ix_availability_doctor_date ON availability (doctor_id, specific_date) WHERE recurrence_type = 'ONE_TIME';

ALTER TABLE schedule_overrides
  ADD CONSTRAINT ck_override_block_window CHECK (
    is_available
    OR ((start_time IS NULL) = (end_time IS NULL) AND (start_time IS NULL OR end_time > start_time))
  );

ALTER TABLE appointments
  ADD COLUMN availability_id uuid REFERENCES availability(id) ON DELETE SET NULL,
  ADD COLUMN slot_capacity   smallint NOT NULL DEFAULT 1,
  ADD COLUMN slot_number     smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT ck_appointment_seat CHECK (slot_capacity >= 1 AND slot_number BETWEEN 1 AND slot_capacity);

-- Best-effort provenance for existing appointments: the one weekly row that covers the start time, and only where the day has no
-- date exception (an exception replaced the weekly hours that day) and exactly one row matches. Anything else stays NULL.
UPDATE appointments ap
   SET availability_id = m.availability_id
  FROM (
    SELECT a.id AS appointment_id, (array_agg(av.id))[1] AS availability_id
      FROM appointments a
      JOIN availability av
        ON av.doctor_id = a.doctor_id
       AND av.recurrence_type = 'WEEKLY'
       AND av.day_of_week = EXTRACT(DOW FROM a.appointment_date)::int
       AND a.start_time >= av.start_time
       AND a.start_time < av.end_time
     WHERE NOT EXISTS (SELECT 1 FROM schedule_overrides so WHERE so.doctor_id = a.doctor_id AND so.override_date = a.appointment_date)
     GROUP BY a.id
    HAVING count(*) = 1
  ) m
 WHERE ap.id = m.appointment_id;

-- One active appointment per doctor, start time AND seat (it was: per doctor and start time). With every existing row on seat 1
-- this is exactly the old rule, so it cannot fail on existing data.
DROP INDEX uq_active_doctor_appointment_start;
CREATE UNIQUE INDEX uq_active_slot_seat
  ON appointments (doctor_id, appointment_date, start_time, slot_number)
  WHERE status IN ('PENDING', 'CONFIRMED');

-- The overlap guard from 007 now applies per seat: two active appointments may not share a seat while their times overlap.
-- STREAM appointments are all seat 1, so for them nothing changes. It is replaced only where 007 managed to add it (it is skipped
-- on databases with overlapping old data or without btree_gist), and never added here where 007 skipped it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ex_appointments_no_overlap') THEN
    ALTER TABLE appointments DROP CONSTRAINT ex_appointments_no_overlap;
    ALTER TABLE appointments
      ADD CONSTRAINT ex_appointments_no_overlap
      EXCLUDE USING gist (
        doctor_id WITH =,
        slot_number WITH =,
        tsrange(appointment_date + start_time, appointment_date + end_time, '[)') WITH &&
      ) WHERE (status IN ('PENDING', 'CONFIRMED'));
  ELSE
    RAISE NOTICE 'ex_appointments_no_overlap was not present (see migration 007), so it is not added here. The booking code still refuses overlaps.';
  END IF;
END $$;
