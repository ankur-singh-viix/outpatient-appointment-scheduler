-- Delivery tracking for notifications, and SMS as a second channel. Additive and backward compatible.
--
-- The notifications table (migration 006) already holds the type (kind), channel, status, attempts, last error, and the sent and
-- created times. This adds who each message is for, the provider's own reference for it, and when it was last tried, so a
-- delivery can be followed from our record to the email or SMS provider's dashboard.
--
--  * recipient_user_id / recipient_role: the person the message is for. Doctors now get messages too, so "which messages are
--    mine" can no longer be worked out from the appointment alone.
--  * provider_reference: Resend's email id or Twilio's message SID, once the provider has accepted the message.
--  * last_attempt_at / updated_at: for monitoring stuck or failing deliveries.
--
-- Every message sent before this migration was an email to the appointment's patient, so those rows are filled in that way.
-- Nothing is deleted or rewritten otherwise.

ALTER TABLE notifications
  ADD COLUMN recipient_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN recipient_role      varchar(20),
  ADD COLUMN provider_reference  varchar(160),
  ADD COLUMN last_attempt_at     timestamptz,
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now();

UPDATE notifications n
   SET recipient_user_id = p.user_id,
       recipient_role = 'PATIENT'
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
 WHERE a.id = n.appointment_id
   AND n.recipient_user_id IS NULL;

ALTER TABLE notifications
  ADD CONSTRAINT ck_notifications_channel CHECK (channel IN ('email', 'sms'));

CREATE INDEX ix_notifications_recipient ON notifications (recipient_user_id, created_at DESC) WHERE recipient_user_id IS NOT NULL;
-- Monitoring: the deliveries that gave up, newest first.
CREATE INDEX ix_notifications_failed ON notifications (updated_at DESC) WHERE status = 'FAILED';
