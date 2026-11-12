# Manual browser walkthrough: extending hours after a reduction

Written for the person running the walkthrough. Nothing here has been observed in a browser: the "Expected" lines are what the code
and the automated tests say should happen, so any difference you see is worth reporting. This is a working note; delete it before
the PR if you do not want it in the repository.

Setup, accounts, browser profiles and the handy SQL are the same as in `docs/manual-test-shrinking.md` (section 0). Short version:
Postgres running, backend `npm run start:dev`, frontend `npm run dev`, doctor `ananya.rao@example.com`, patients A (Rahul) and B
(Sneha) plus a third patient C, password `Demo@1234`. With `RESEND_API_KEY` empty, emails print in the backend terminal as `[DEV ...]`.

Two switches are used below to make timing controllable:

- **Jobs off**: start the backend with `BACKGROUND_JOBS=false`. Nothing is asked, queued or sent in the background. Restart with
  `true` (the default) to let the job run. Use this to extend "before anyone was told".
- **Hold the outbox** (dev database only): this keeps "choose a new time" emails queued, unsent, so you can see them withdrawn.

  ```sql
  CREATE OR REPLACE FUNCTION hold_new_time() RETURNS trigger AS $$ BEGIN
    IF NEW.kind = 'needs-new-time' THEN NEW.send_at := now() + interval '30 minutes'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
  CREATE TRIGGER hold_new_time BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION hold_new_time();
  -- when finished:
  DROP TRIGGER hold_new_time ON notifications; DROP FUNCTION hold_new_time();
  ```

Base fixture for every scenario unless it says otherwise: the doctor has a Wave Monday session **10:00 to 12:00**, 30-minute slots, 3
places per slot; patient A has booked **11:00**, patient B **11:30**, patient C **10:00**, all on Monday `M` (at least 8 days ahead).
Then **Adjust hours** on that session, end time **11:00**, tick the agreement, save. A and B are now outside the hours; C is not.

Queries used below:

```sql
SELECT u.name, a.start_time, a.status, s.notified_at, s.resolution, s.resolved_at
  FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id
  JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id ORDER BY a.start_time;                       -- (T) tracking
SELECT u.name, n.status, n.last_error, n.send_at FROM notifications n JOIN appointments a ON a.id = n.appointment_id
  JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id WHERE n.kind = 'needs-new-time' ORDER BY n.created_at;  -- (N) notices
SELECT kind, old_start_time, old_end_time, new_start_time, new_end_time, affected_count, created_at FROM schedule_changes ORDER BY created_at; -- (H) history
SELECT a.id, u.name, a.appointment_date, a.start_time, a.status, a.cancel_reason FROM appointments a
  JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id ORDER BY a.created_at;                         -- (A) appointments
```

## 1. Shrink, then extend before anyone was told

1. Backend with **jobs off**. Set up the base fixture and reduce to 11:00.
2. Doctor, Availability: **Appointments outside your hours** lists A and B, each "Not asked yet". (T): two rows, `notified_at` empty.
3. **Adjust hours** on the (new) 10:00 to 11:00 session, set the end back to **12:00**. The preview shows a green panel: "2 booked
   appointments are back inside your hours", naming A and B. No agreement box. Save.
4. Expected: success message ends "2 appointments that were waiting for a new time are back inside your hours...". The outside-hours
   list disappears. "Recent changes to your hours" shows the extension with "2 appointments waiting for a new time were back inside the hours".
5. Database: (T) both rows `COVERED`, `resolved_at` set, `notified_at` empty. (N) no rows at all. (A) A and B still `CONFIRMED`,
   same times. Restart the backend with jobs on and wait a minute: still no email in the terminal.
6. Unexpected: any email, a changed appointment, an open tracking row.

## 2. Shrink, notify, then extend

1. Jobs on. Hold the outbox. Base fixture, reduce to 11:00. Wait about 30 seconds.
2. (N): two rows `PENDING`, `send_at` 30 minutes ahead. (T): `notified_at` set, `resolution` empty. Doctor list: "Asked ..., email on its way".
3. Extend back to 12:00 (preview shows the green panel). Save; the message says 2 released.
4. Expected: (T) both `COVERED`. (N) both `CANCELLED`, `last_error` = "Not sent: the appointment is within the doctor's hours again."
5. Drop the trigger, wait a minute. No email appears for A or B in the terminal.
6. Variant, email already sent: repeat without holding the outbox, let the emails print, then extend. (N) stays `SENT`; (T) `COVERED`;
   the appointments are unchanged. Nothing is retracted, which is expected.

## 3. Partial expansion

1. Jobs on, hold the outbox. Base fixture, reduce to 11:00 (A at 11:00, B at 11:30 outside). Wait for the notices to queue.
2. Extend the end to **11:30** (not 12:00). The preview green panel names **A only**.
3. Expected after saving: (T) A `COVERED`; B open with `notified_at` set. (N) A `CANCELLED`, B `PENDING`. The outside-hours list
   still shows B. Drop the trigger: only B's email is sent.
4. Extend to 12:00: B is released too (`COVERED`, notice `CANCELLED` if still held).

## 4. Patient already rescheduled before the expansion

1. Jobs on. Base fixture, reduce to 11:00, wait for the emails. As patient A open the email link (or Appointments, **Choose a new
   time**), pick a time, **Confirm move**.
2. Wait about 30 seconds so the record closes. (T): A `RESCHEDULED`. (A): the old 11:00 is `CANCELLED` "Rescheduled by patient", a new
   `CONFIRMED` one exists. Check payments if A paid: `SELECT appointment_id, status, amount_paise FROM payments;` one row, on the new appointment.
3. As the doctor, extend to 12:00. Expected: only B is released. A's row stays `RESCHEDULED` (same `resolved_at`); the old appointment
   stays cancelled; the new one is untouched; the payment row is identical. Re-run (A) and the payments query before and after to compare.
4. Variant: the doctor cancels B instead (outside-hours list, **Cancel appointment (last resort)**), then extend. B stays `CANCELLED`.

## 5. One-time session and date-exception expansion

Start from scenario 2's state (A and B outside, notices queued), each of these on its own fixture:

1. **One-time session.** Doctor, **Add a one-time session** for date `M`, 11:00 to 12:00 (the shortcut on A's row opens the form on
   that date). Expected: success message says the appointments are back inside your hours; (T) `COVERED`; the weekly session is not
   changed; (N) cancelled/none sent. A one-time session on a *different* date releases nobody.
2. **Day off does not release.** Add a date exception "day off" for `M`, then extend the weekly hours to 12:00. Expected: the preview
   shows no green panel (nothing to release), and A and B stay on the outside-hours list and keep waiting. Then delete the exception:
   success message says 2 are back inside; (T) `COVERED`.
3. **Blocked part of the day.** Block 11:00 to 12:00 on `M`, extend to 12:00: nobody released. Remove the block: released.
4. **Replacement hours.** Set different hours on `M`, 11:00 to 13:00: A and B are released by saving the exception.
5. **Recurring from a later date.** With A booked on `M` and B on the Monday a week later, reduce to 11:00 (from today), then extend with
   **Apply from** set to the second Monday. Expected: the preview names only B. After saving, B is released; A is still waiting.

## 6. Opening an old notification link after the expansion

1. Jobs on, outbox not held. Base fixture, reduce to 11:00. Copy A's email link from the backend terminal
   (`.../doctors/<id>?reschedule=<appointment id>`). Do not use it yet.
2. Doctor extends to 12:00.
3. As patient A (signed in), open the copied link. Expected: the normal reschedule page for A's existing appointment, with nothing
   wrong or expired. Do not confirm a move; the appointment should still show as Confirmed at 11:00.
4. Appointments page: no "Doctor changed their hours" banner, and the button reads **Reschedule** (not "Choose a new time").
5. Stale panel: before step 2, as A open Appointments and click **Choose a new time** (leave it open). After the doctor extends,
   reload the page (the banner and button will already have changed), or close and reopen the panel if the page still shows it. Expected: a green note "Your appointment fits Dr X's hours again. You do not need to choose
   a new time", while still allowing a move.
6. Unexpected: an error page, an empty list with no explanation, or the appointment moved/cancelled.

## 7. Concurrent booking and expansion

1. Base fixture, reduce to 11:00 so 11:00 to 12:00 is closed to new bookings. Patient C opens the doctor's page for `M` and sees 11:00 and 11:30 gone.
2. Patient B in a second window has the booking page open on `M`.
3. The doctor opens Adjust hours and has the extend preview ready. Click **Apply change** and, in the same second, patient C refreshes and
   tries to book 11:30.
4. Expected: the booking either fails with a clear message ("not available") or succeeds, depending on which lands first; never an error
   page. The doctor's save succeeds. Then:
   `SELECT appointment_date, start_time, count(*) FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY 1, 2, slot_number HAVING count(*) > 1;`
   returns no rows (no seat is double-booked), and 11:30 holds at most its 3 places.
5. Double click: click **Apply change** twice quickly. Expected: one change; (H) has a single new EXPAND row.
6. Two doctors' tabs: with the preview open in two tabs, apply in one, then the other. The second says the session changed since the
   preview and asks you to preview again.

## 8. Shrink again after an unsent notification was withdrawn

1. Jobs on, hold the outbox. Base fixture, reduce to 11:00, wait for the notices to queue, then extend to 12:00. (N): both `CANCELLED`.
2. Reduce to 11:00 again. Wait about 30 seconds.
3. Expected: **new** notices for A and B are queued (`PENDING`, a second row each), because the first never reached them. (T) has new
   rows for the second change; the earlier `COVERED` rows are unchanged. (H) shows SHRINK, EXPAND, SHRINK.
4. Drop the trigger: A and B each get exactly one email.
5. Contrast: repeat but let the first emails be **sent** (no hold) before extending, then reduce again within a day. Expected: **no**
   new email (the 24-hour rule), but the records and the outside-hours list update as usual.

## What to report back

For each scenario: pass or what you saw instead, with the (T), (N), (A) rows where it differs. Particularly worth a look: the wording
of the green panel and the success messages, whether the history list reads clearly, and how the patient page behaves for a released appointment.
