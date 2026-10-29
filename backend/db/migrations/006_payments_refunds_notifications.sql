-- Razorpay payments, refunds and the notification outbox. Additive and backward compatible:
--  * appointments gets one nullable column; every existing row keeps working and stays as it is.
--  * four new tables. Nothing is dropped, renamed or rewritten.
-- Money is stored as integer paise (1 rupee = 100 paise), the unit Razorpay uses, so no rounding can creep in.

-- Set only while an appointment is an unpaid HOLD (status PENDING): the moment the hold lapses and the slot is released.
-- Null for every confirmed appointment and every appointment that existed before this migration.
ALTER TABLE appointments ADD COLUMN hold_expires_at timestamptz;
CREATE INDEX ix_appointments_hold_expiry ON appointments (hold_expires_at) WHERE status = 'PENDING' AND hold_expires_at IS NOT NULL;

CREATE TYPE payment_status AS ENUM ('CREATED', 'FAILED', 'PAID', 'EXPIRED');
CREATE TYPE refund_status AS ENUM ('PENDING', 'PROCESSED', 'FAILED');
CREATE TYPE notification_status AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- One Razorpay order per booking attempt. Amounts always come from doctors.consultation_fee, never from the browser.
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id      uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  razorpay_order_id   varchar(64) NOT NULL,
  razorpay_payment_id varchar(64),
  amount_paise        integer NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'INR',
  status              payment_status NOT NULL DEFAULT 'CREATED',
  failure_reason      text,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payments_order UNIQUE (razorpay_order_id),
  CONSTRAINT uq_payments_payment UNIQUE (razorpay_payment_id),
  CONSTRAINT ck_payments_amount CHECK (amount_paise > 0),
  CONSTRAINT ck_payments_paid CHECK (status <> 'PAID' OR (razorpay_payment_id IS NOT NULL AND paid_at IS NOT NULL))
);
-- At most one live payment per appointment, so a booking can never be charged twice.
CREATE UNIQUE INDEX uq_payments_live_per_appointment ON payments (appointment_id) WHERE status IN ('CREATED', 'FAILED', 'PAID');
CREATE INDEX ix_payments_patient ON payments (patient_id, created_at DESC);

-- Every refund, with who asked for it and why. A refund is PROCESSED only after Razorpay confirms it.
CREATE TABLE refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id           uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount_paise         integer NOT NULL,
  reason               text NOT NULL,
  status               refund_status NOT NULL DEFAULT 'PENDING',
  razorpay_refund_id   varchar(64),
  idempotency_key      varchar(120) NOT NULL,
  initiated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT, -- null: refunded automatically by the cancellation policy
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  CONSTRAINT uq_refunds_idempotency UNIQUE (idempotency_key),
  CONSTRAINT uq_refunds_razorpay UNIQUE (razorpay_refund_id),
  CONSTRAINT ck_refunds_amount CHECK (amount_paise > 0),
  CONSTRAINT ck_refunds_processed CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL)
);
CREATE INDEX ix_refunds_payment ON refunds (payment_id);

-- Razorpay webhook event ids already handled, so a redelivered event is acknowledged without being applied twice.
CREATE TABLE payment_events (
  event_id    varchar(120) PRIMARY KEY,
  event_type  varchar(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Outbox for every message CareSlot sends (booking, payment, refund, cancellation, reminders). Rows are written inside the
-- same transaction as the change they describe and delivered afterwards, so a provider outage never loses a message and a
-- retry never sends one twice (dedupe_key). A reminder is just a row with a future send_at that gets CANCELLED if the
-- appointment is cancelled or moved.
CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  channel        varchar(20) NOT NULL DEFAULT 'email',
  kind           varchar(40) NOT NULL,
  to_address     varchar(255) NOT NULL,
  subject        varchar(200) NOT NULL,
  body           text NOT NULL,
  send_at        timestamptz NOT NULL DEFAULT now(),
  status         notification_status NOT NULL DEFAULT 'PENDING',
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  sent_at        timestamptz,
  dedupe_key     varchar(160) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_dedupe UNIQUE (dedupe_key)
);
CREATE INDEX ix_notifications_due ON notifications (send_at) WHERE status = 'PENDING';
CREATE INDEX ix_notifications_appointment ON notifications (appointment_id) WHERE status = 'PENDING';
