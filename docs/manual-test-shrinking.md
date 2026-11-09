# Manual browser walkthrough: shrinking hours

Written for the person running the walkthrough. Nothing here has been observed in a browser yet: the "Expected" lines are what the
code and the automated tests say should happen, so any difference you see is worth reporting. This file is a working note; delete
it before the PR if you do not want it in the repository.

## 0. Setup (once)

1. Start Docker, then `docker start outpatient-postgres` if it is not running.
2. `cd backend && npm run db:migrate` (applies migration 011 to the **dev** database; it only adds two tables).
3. Backend `npm run start:dev` (port 3000), frontend `npm run dev` (port 3001). Leave `BACKGROUND_JOBS=true`.
   With `RESEND_API_KEY` empty, emails are printed in the backend terminal as `[DEV ...]`: that is where you "read" the notices.
4. Accounts (password `Demo@1234`): doctor `ananya.rao@example.com`; patients `patient@example.com` (Rahul) and
   `sneha.gupta@example.com`. You need a third patient: sign up at `/signup/legacy` (the code is printed in the backend terminal).
5. Use three browser profiles (or one normal and two private windows) so doctor, patient A and patient B stay signed in together.
6. A SQL prompt: `docker exec -it outpatient-postgres psql -U postgres -d outpatient` (use `\x` for readable rows).
7. Dates: pick a date `D` between 2 and 10 days ahead, and a Monday `M` at least 8 days ahead (for the recurring case).
   Slots below are 30 minutes; I call the patients A (Rahul), B (Sneha), C (third).

Handy queries (replace the doctor name if needed):

```sql
-- the doctor id
SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.email = 'ananya.rao@example.com';

-- appointments with who and when (newest first)
SELECT a.id, u.name, a.appointment_date, a.start_time, a.status, a.cancel_reason, a.rescheduled_from_id, a.availability_id
  FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id
 ORDER BY a.created_at DESC LIMIT 15;

-- the change record and what became of each affected appointment
SELECT c.created_at, c.kind, c.apply_from, c.old_start_time, c.old_end_time, c.new_start_time, c.new_end_time, c.affected_count
  FROM schedule_changes c ORDER BY c.created_at DESC LIMIT 5;
SELECT s.change_id, u.name, a.start_time, a.status, s.notified_at, s.attempts, s.resolution, s.resolved_at
  FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id
  JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id ORDER BY s.created_at DESC;

-- the notices
SELECT created_at, to_address, status, kind, left(subject, 60) FROM notifications WHERE kind = 'needs-new-time' ORDER BY created_at DESC;

-- payments and refunds
SELECT * FROM payments ORDER BY created_at DESC LIMIT 5;
SELECT * FROM refunds ORDER BY created_at DESC LIMIT 5;
```

Start every scenario from a clean slate: as the doctor, remove old sessions you made, and cancel old test appointments.

---

## 1. Shrink with nobody affected

**Steps.** Doctor, Availability, add a non-recurring Wave session on `D`, 10:00 to 12:00, 1 patient per slot, 30-minute slots. As A
book 10:00. As the doctor open Your availability, Adjust hours on that session, set the end to 11:30.
**Expected.** Preview says "No booked appointment falls outside the new hours, so nobody needs to be contacted". Button reads
"Apply change". After saving, the 11:30 slot is gone for patients; A's booking is untouched; no "Appointments outside your hours" card.
**Verify.** `schedule_changes` has one SHRINK row with `affected_count = 0`; `schedule_change_appointments` empty; no
`needs-new-time` notice; A's appointment still CONFIRMED.

## 2. Shrink with one appointment affected

**Steps.** Same session. A books 11:00. Adjust hours, end to 11:00.
**Expected.** Preview: "1 booked appointment falls outside the new hours", lists A with open alternatives, and an agreement tick box;
the button stays disabled until you tick it and then reads "Reduce hours and ask patients". Saving returns quickly.
**Verify.** `schedule_changes.affected_count = 1`; one tracking row, `notified_at` empty at first and set within about a minute;
exactly one `needs-new-time` notice to A (also printed in the backend terminal); A's appointment still CONFIRMED, same id, same time.

## 3. Shrink with several affected

**Steps.** Session 10:00 to 12:00, 1 per slot. A books 11:00, B books 11:30, C books 10:00. End to 11:00 (A and B affected, C not).
**Expected.** Count "2 booked appointments"; both listed, C not. After saving the doctor card shows both as "Needs a new time" and
"Waiting to be asked" turning into "Asked ... (email on its way / email sent)".
**Verify.** Two tracking rows, two notices (to A and B, none to C), all three appointments CONFIRMED.

## 4. Unaffected appointments unchanged

**Steps.** After scenario 3, run the appointments query.
**Expected.** C's row: same id, status, start time, `availability_id` (for a one-time session it is unchanged; for a recurring one
see scenario 16), no tracking row, no notice, no new notification of any kind for C beyond the original booking messages.

## 5. Affected appointments stay booked and visible

**Steps.** As A, open Appointments, Upcoming.
**Expected.** A's appointment is still listed as Confirmed, with the amber note "Doctor changed their hours ... Your appointment is still
booked. Choose a new time to move it; you will be asked to confirm, and nothing changes unless you do." and a "Choose a new time" button.
**Verify.** Status CONFIRMED, nothing cancelled (`SELECT count(*) FROM appointments WHERE status = 'CANCELLED'` unchanged).

## 6. Patient sees the warning and alternatives

**Steps.** As A press "Choose a new time".
**Expected.** A panel "Pick a new time with Dr ..." lists up to 8 real open times (not the removed time, not C's 10:00 slot, not
the time A already has), plus "See every available date". Closing the panel changes nothing.
**Verify.** Nothing in the database changes from opening or closing the panel.

## 7. Patient selects and confirms

**Steps.** A picks a time; the panel shows "Move your appointment from ... to ...?" with **Confirm move** and **Back**. Press Back once
(nothing moves), pick again, press Confirm move (try double-clicking it).
**Expected.** Green notice "Your appointment has been moved ..."; Upcoming shows the new time; Past shows the old one as cancelled
(rescheduled). Only one new appointment is created.
**Verify.** Old row CANCELLED with `cancel_reason = 'Rescheduled by patient'`; exactly one new CONFIRMED row with
`rescheduled_from_id` = old id; within about 30 s the tracking row gets `resolution = 'RESCHEDULED'`; the doctor card drops A.

## 8. Two patients, one last slot

**Steps.** Fresh one-time session on `D` (so only that date exists), 10:00 to 12:00, 1 per slot. A books 11:00, B books 11:30, C books
10:00; the 10:30 slot stays empty. Shrink to end 11:00. A and B both open "Choose a new time": each should offer exactly one time,
10:30. Both select it, then press **Confirm move** at the same moment (count to three).
**Expected.** One patient moves. The other sees an error that the time was taken, and the panel refreshes.
**Verify.** Exactly one active appointment at 10:30; the loser's original appointment is still CONFIRMED (not cancelled, not moved);
no duplicate rows.

## 9. No alternatives

**Steps.** Continue from 8 as the loser.
**Expected.** The panel says "No other time is open with Dr ... right now. Your appointment is still booked and nothing has changed",
suggesting checking later, contacting the clinic or cancelling. Doctor card: that patient shows "No other time is open for this patient
right now" with **Add a one-time session**.
**Verify.** The loser's appointment still CONFIRMED and tracked (`resolved_at` empty).

## 10. Doctor adds a one-time session

**Steps.** Doctor presses **Add a one-time session** on the card. The form opens on that date as a one-time session; set 14:00 to 15:00,
save. As the loser, reload Appointments and open "Choose a new time".
**Expected.** 14:00 and 14:30 now appear; confirming moves the patient. The recurring (weekly) rows are not changed by this.
**Verify.** A new ONE_TIME `availability` row; no WEEKLY rows touched (`SELECT * FROM availability ORDER BY created_at DESC`).

## 11. Shrink again while others are unresolved

**Steps.** Before the loser from 8 has moved, shrink the same session again to end 10:30 (the winner at 10:30 becomes affected; C at
10:00 stays).
**Expected.** Preview counts only newly affected appointments (the winner), not the loser who is already outside. The doctor card
lists both without duplicates. The history panel ("Recent changes to your hours") shows two changes.
**Verify.** Two `schedule_changes` rows; tracking rows only for appointments each change newly affected; no appointment lost.

## 12. No repeat notice within 24 hours

**Steps.** Session with A at 11:00. Shrink to end 11:00 (A is asked). Widen back to 12:00, then shrink to 11:00 again, within minutes.
**Expected.** The second time the preview again counts A, but A receives no second email.
**Verify.** `needs-new-time` notices for A: exactly 1; two tracking rows for A, both with `notified_at` set (the second marks "already
asked" without creating a notice). The doctor can still use "Ask to choose a new time"; within 24 h it answers "You have already asked
this patient in the last 24 hours".

## 13. Notification failure and retry

**Steps.** Make queuing fail on purpose (dev database only):
`ALTER TABLE notifications ADD CONSTRAINT block_test CHECK (kind <> 'needs-new-time') NOT VALID;`
Shrink so A is affected. Watch the backend terminal for "Could not queue the new-time notice". After about a minute run
`ALTER TABLE notifications DROP CONSTRAINT block_test;` and wait one more minute.
**Expected.** While blocked, the doctor card shows A as "Waiting to be asked"; `attempts` climbs (about one per 30 s). After you drop
the constraint, the next pass sends the notice and `notified_at` is set. If you wait past 5 attempts it stops retrying but stays
visible; reset it with `UPDATE schedule_change_appointments SET attempts = 0 WHERE notified_at IS NULL;` or use the doctor's
"Ask to choose a new time" button.
**Always** drop `block_test` afterwards.

## 14. Patient cancels (existing workflow)

**Steps.** As an affected patient, press **Cancel appointment**, confirm.
**Expected.** Normal cancellation message, slot freed, refund rules as for any cancellation. The doctor card drops the patient within
about 30 s.
**Verify.** Appointment CANCELLED with a reason; tracking row `resolution = 'CANCELLED'`; refund/notice exactly as an ordinary cancel.

## 15. Payment and refund consistency

Needs the doctor's fee above 0 (Doctor, Profile) and your own Razorpay **test** keys in `backend/.env`. Without keys you can only
confirm that nothing payment-related appears for free bookings.
**Steps.** Patient books an affected-to-be slot and pays with a Razorpay test card. Doctor shrinks. (a) Patient moves via the panel.
(b) Repeat with a second paid booking and cancel instead.
**Expected.** (a) The payment stays PAID and now belongs to the new appointment; no refund row; no second charge. (b) A cancel
follows the refund policy for how far away the appointment is (full 24 h or more, partial 2 to 24 h, none under 2 h by default); the
patient gets a refund notice.
**Verify.** `payments.appointment_id` equals the new appointment id after (a), `refunds` empty; after (b) one refund with the policy
amount. Money must never be both kept and refunded.

## 16. Recurring and one-time

**Recurring.** Add a weekly Monday session 10:00 to 12:00 on `M`'s weekday. Have A book `M` at 11:30 and B book `M + 7` at 11:30. Adjust
hours on the weekly session, apply from `M + 7`, end 11:00.
**Expected.** Preview says earlier dates keep their hours. A (on `M`) is not affected and not asked; B is. The session list still shows
one weekly session.
**Verify.** `availability` now has two WEEKLY rows: the old one with `effective_to = M + 6` and a new one with `effective_from = M + 7`
and the shorter end; B's appointment `availability_id` points to the new row, A's to the old.
**One-time.** Scenarios 1 to 3, 8 to 10 already used a one-time session; check there that no extra `availability` rows are created
by shrinking it (it is edited in place).
**Day off.** Also try a date exception (a day off) on a day with a booking: that patient appears in the card and is asked, nothing
cancelled.

---

## Things to watch for (report any of these)

- A notice before you press Apply, or an email in the terminal for a patient who is not affected.
- Any appointment cancelled or moved without the patient pressing Confirm move.
- The warning text missing, or "Choose a new time" showing for an appointment inside the hours.
- A time offered that is the removed time, already full, or the patient's own.
- The doctor card not updating within about a minute after a patient moves or cancels.
- Two notices to one patient inside 24 hours.
- Layout problems at phone width in the patient panel and the doctor card.

When you finish, remember to remove the `block_test` constraint and any test sessions and appointments.
