-- A patient can remove a PAST booking (cancelled, completed or no-show) from their own appointment list.
--
-- "Hide", not delete: a booking backs payments, receipts, refunds and the doctor's records, so the row stays exactly as it is. This only
-- records WHEN the patient removed it from their own list. Only that list reads it: doctor, receptionist and admin views, payments,
-- receipts and refunds never look at this column.
--
-- Additive and backward compatible: one nullable column (every existing row keeps working and stays visible), and one small index.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hidden_by_patient_at timestamptz;

-- "Which of this patient's bookings are hidden?" touches only the few hidden rows.
CREATE INDEX IF NOT EXISTS ix_appointments_hidden ON appointments (patient_id) WHERE hidden_by_patient_at IS NOT NULL;
