# Patient UHID and medical profile (migration 018)

## Production deployment order

Apply the database change **before** shipping the backend that reads or writes `patients.uhid`.

1. **Take a database backup** of the production database.
2. **Apply migration 018** (`backend/db/migrations/018_patient_uhid_and_medical_profile.sql`) via the normal migrator (`npm run db:migrate` / `db:migrate:prod`).
3. **Verify** after migrate:
   - `patients.uhid` exists, is `NOT NULL`, and has values for every existing patient.
   - Sequence `patient_uhid_seq` exists.
   - Unique constraint `uq_patients_uhid` exists.
   - Table `patient_medical_profile_history` exists.
4. **Deploy the new backend** only after those checks pass.

Shipping the new app before 018 will break patient signup and profile reads (`uhid` / `patient_uhid_seq` missing).

## Forward-only rollback

Treat migration 018 as **forward-only** in production.

- Do **not** manually `DROP` `patient_medical_profile_history`, UHID columns, the allocate trigger/function, or `patient_uhid_seq` to reverse a release.
- That would destroy patient medical history and permanent identifiers.
- If you must revert the release, **restore from the pre-migration backup** and redeploy the previous application build.

## UHID notes

- Existing patient UUIDs are unchanged; appointments, queue entries and prescriptions keep the same `patient_id` foreign keys.
- Backfilled `CC-UHID-######` values are unique and permanent. Sequential numbers are **not** guaranteed to match patient registration chronology.
- Formatting uses at least six digits; sequence values above `999999` remain unique (the string simply grows; it still fits `varchar(32)`).
