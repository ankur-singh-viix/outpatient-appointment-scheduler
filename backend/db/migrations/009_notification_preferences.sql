-- Patient notification preferences and message categories. Additive and backward compatible.
--
-- Messages fall into three categories:
--   transactional  what the patient needs to know about their own appointment and money: confirmation, cancellation, rescheduling,
--                  payment receipt and failure, refund updates. These are ALWAYS sent by email and cannot be switched off; the
--                  patient can only choose whether they ALSO get a text (sms_enabled).
--   reminder       appointment reminders. Optional, separately for email and SMS.
--   promotional    offers and health tips. NEVER sent without the patient's explicit opt-in, recorded with the time it was given.
--                  Nothing promotional is sent today; this is the consent record and gate for when something is.
--
-- A patient with no row here has the defaults below, which is exactly how they were treated before this migration (essential
-- emails and texts and reminders on, nothing promotional). So no existing patient's messages change.

CREATE TABLE notification_preferences (
  user_id                      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sms_enabled                  boolean NOT NULL DEFAULT true,
  email_reminders              boolean NOT NULL DEFAULT true,
  sms_reminders                boolean NOT NULL DEFAULT true,
  promotional_email            boolean NOT NULL DEFAULT false,
  promotional_email_consent_at timestamptz,
  promotional_sms              boolean NOT NULL DEFAULT false,
  promotional_sms_consent_at   timestamptz,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  -- Consent is a fact with a date: you cannot be opted in without a record of when.
  CONSTRAINT ck_preferences_email_consent CHECK (NOT promotional_email OR promotional_email_consent_at IS NOT NULL),
  CONSTRAINT ck_preferences_sms_consent CHECK (NOT promotional_sms OR promotional_sms_consent_at IS NOT NULL)
);

ALTER TABLE notifications ADD COLUMN category varchar(20) NOT NULL DEFAULT 'transactional';
-- Reminders queued before this migration were already of the reminder kind.
UPDATE notifications SET category = 'reminder' WHERE kind = 'reminder';
ALTER TABLE notifications ADD CONSTRAINT ck_notifications_category CHECK (category IN ('transactional', 'reminder', 'promotional'));
