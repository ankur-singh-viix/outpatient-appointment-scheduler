-- Queue tokens are issued when a booking is confirmed (not only at check-in).
--
-- Additive / relaxing only:
--  - status BOOKED = token reserved, patient has not arrived yet
--  - checked-in columns become nullable until check-in
--  - audit event BOOKED when the token is first issued
-- Check-in moves BOOKED -> WAITING and keeps the same token_number.
--
-- To undo (after no BOOKED rows remain): restore the old CHECKs and NOT NULL checked-in columns.

ALTER TABLE queue_entries
  ALTER COLUMN checked_in_at DROP NOT NULL,
  ALTER COLUMN checked_in_at DROP DEFAULT,
  ALTER COLUMN checked_in_by_user_id DROP NOT NULL;

ALTER TABLE queue_entries DROP CONSTRAINT IF EXISTS queue_entries_status_check;
ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_status_check
  CHECK (status IN ('BOOKED', 'WAITING', 'SERVING', 'COMPLETED', 'CHECKED_OUT', 'SKIPPED', 'CANCELLED'));

ALTER TABLE queue_entries DROP CONSTRAINT IF EXISTS ck_queue_checked_in_when_waiting;
-- Waiting (and later) entries must have been checked in; BOOKED ones must not yet.
ALTER TABLE queue_entries
  ADD CONSTRAINT ck_queue_checked_in_consistency CHECK (
    (status = 'BOOKED' AND checked_in_at IS NULL AND checked_in_by_user_id IS NULL)
    OR (status <> 'BOOKED' AND checked_in_at IS NOT NULL AND checked_in_by_user_id IS NOT NULL)
  );

ALTER TABLE queue_events DROP CONSTRAINT IF EXISTS queue_events_event_check;
ALTER TABLE queue_events
  ADD CONSTRAINT queue_events_event_check
  CHECK (event IN ('BOOKED', 'CHECKED_IN', 'CALLED', 'COMPLETED', 'CHECKED_OUT', 'SKIPPED', 'RETURNED', 'CANCELLED'));
