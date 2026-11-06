-- Records WHO cancelled an appointment (the patient, or now also the doctor), next to the existing reason and timestamp.
-- Until this migration only patients could cancel, so earlier cancellations (including the old appointment of a
-- reschedule) are attributed to the appointment's patient. A cancelled appointment must always say who cancelled it.

ALTER TABLE appointments
  ADD COLUMN cancelled_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

UPDATE appointments a
   SET cancelled_by_user_id = p.user_id
  FROM patients p
 WHERE p.id = a.patient_id
   AND a.status = 'CANCELLED'
   AND a.cancelled_by_user_id IS NULL;

ALTER TABLE appointments
  ADD CONSTRAINT ck_appointment_cancelled_by CHECK (status <> 'CANCELLED' OR cancelled_by_user_id IS NOT NULL);
