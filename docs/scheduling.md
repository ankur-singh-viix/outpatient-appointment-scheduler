# Scheduling approach

How CareSlot decides what a patient can book, and how booking, cancelling and rescheduling stay correct.

## 1. Stream vs wave scheduling

| | Stream | Wave |
|---|---|---|
| Idea | One patient per time slot, one after another | Several patients per time block, up to a capacity |
| Good for | Short, uniform visits; a predictable day | Variable visit lengths; clinics with frequent no-shows |
| Strength | Each patient has an exact time, so there is little waiting | Absorbs no-shows and overruns; the doctor is rarely idle |
| Weakness | A no-show leaves an idle gap | Patients in a block queue; order inside a block is vague, so you need arrival rules |
| Needs | A slot grid | A capacity per block, plus an arrival or queue rule |

### The definitions CareSlot implements

**WAVE**
- A scheduling window is divided into slots of `slot_duration_minutes`, back to back.
- Each slot takes up to `capacity_per_slot` patients. Capacity applies to every slot independently.

**STREAM**
- A scheduling window is divided into slots of `slot_duration_minutes`.
- Exactly one patient can book each slot. Capacity per slot is always 1 (a database CHECK enforces it).
- Slots may start more often than they are long (the doctor's *slot interval*, for example 30-minute visits every 15
  minutes). The doctor's interval applies to STREAM windows whose slot length is the doctor's own length. A WAVE window,
  or a window with its own slot length, is always cut into back-to-back slots.
- A STREAM window also keeps the legacy `capacity` column: an optional cap on bookings in the whole session
  (the hybrid CareSlot always had). WAVE ignores it, because each slot has its own capacity.

**Recurrence**
- `WEEKLY`: the window repeats on `day_of_week` (0 = Sunday ... 6 = Saturday).
- `ONE_TIME`: the window applies on `specific_date` only.
- `effective_from` / `effective_to` (optional, inclusive) limit the dates a row applies on.

Every availability row has a mode (`scheduling_mode`: `STREAM` default, or `WAVE`). Existing rows are `WEEKLY`, `STREAM`,
one patient per slot, with the doctor's consultation length as slot length, so nothing changed for existing doctors.

## 2. How availability is worked out

For a doctor and a date, the server (`backend/src/scheduling/`, pure rules in `availability-rules.ts` and `slots.ts`):

1. Picks the rows that apply on the date (weekday or date matches, inside the effective range).
2. Resolves them by **precedence**, highest first:
   1. **Schedule override** (a date exception).
   2. **ONE_TIME** availability for the date.
   3. **WEEKLY** availability for the weekday.
3. Splits every resulting window into slots and marks each one.

### Precedence rules

- **Higher priority wins only the time it overlaps.** A ONE_TIME window 10:00-11:00 over a weekly 09:00-12:00 removes
  every weekly slot that overlaps 10:00-11:00; the weekly slots before 10:00 and after 11:00 are still offered. A ONE_TIME
  window with no weekly row simply adds hours.
- **Rows of the same kind that overlap**: the earlier-starting row wins the overlap (ties broken by id), so one moment is
  never offered twice. The API refuses to *create* such overlaps (unless their effective date ranges do not intersect).
- **Date exception, available**: replaces the whole day, as it always has (existing exceptions mean exactly what they
  meant before). The replacing window inherits mode, slot length and capacity per slot from the first session the day would
  otherwise have had, or is STREAM with the doctor's slot length when there is none. Its `capacity` is the STREAM session cap.
- **Date exception, unavailable, no times**: a day off. No sessions; the reason is returned as `unavailableReason`.
- **Date exception, unavailable, with start and end** (partial-day): blocks only that time. Everything else the day would
  have had is still offered, but no slot that overlaps the blocked time is. Back-to-back slots (one ending exactly when the
  block starts) are not blocked.
- Slots that are excluded are not in the list at all, so booking one answers `400` ("no appointment slot at that time").

### Slot status

For each slot, with `taken` = active appointments that share any time with the slot:

- `BOOKED`: `taken >= capacity_per_slot` (a STREAM slot with one patient, or a WAVE slot with every seat taken).
- `PAST`: the slot starts at or before now, in the clinic time zone.
- `FULL`: a STREAM session has reached its session cap.
- `AVAILABLE`: otherwise.

"Active" means `PENDING` or `CONFIRMED`; a payment hold that has run out no longer counts. Slots also carry
`capacityPerSlot`, `booked`, `remaining`, `mode` and `availabilityId`. `GET /api/doctors/:id/slots?date=...&availableOnly=true`
returns only slots that can be booked right now (not full, past or unavailable).

The same function lists slots and validates a booking, so what a patient sees is what the server accepts.

### Seats

Every appointment holds a **seat** in its slot: `slot_number` (1..`slot_capacity`). A STREAM slot has one seat. Booking takes
the lowest free seat, and a seat freed by a cancellation is reused. The seat decides what the database enforces (section 5).

## 3. Doctor configuration (already working, now complete)

| Setting | Where | Notes |
|---|---|---|
| Working days, session start and end | Doctor dashboard → Availability → Weekly working hours | Overlapping sessions on a day are rejected. Each session must fit at least one slot. |
| Capacity per session | Same editor | 1–200 bookings per session. |
| Day off or different hours for one date | Date exceptions | Replaces the weekly hours for that date. |
| **Slot length** | Availability → Slot length | **New.** 5–120 minutes. Refused while upcoming appointments exist, or when a session would be shorter than the new length. |
| **WAVE or STREAM, slot length, capacity per slot, effective dates** | `PUT /api/doctor-portal/availability/weekly` | Optional per row. Omitted means STREAM, the doctor's slot length, one patient per slot. |
| **One-time sessions** | `POST /api/doctor-portal/availability/one-time`, `DELETE .../one-time/:id` | One date, same options as a weekly row. Listed as `oneTime` in `GET /api/doctor-portal/availability`. |
| **Block part of a day** | `PUT /api/doctor-portal/availability/overrides` | `isAvailable: false` with `startTime` and `endTime`. |

All of it is stored in PostgreSQL and shows up immediately in patient availability.

Why slot length is locked while appointments exist: an appointment keeps its own start and end time. A longer slot
could overlap an existing booking, so the change is refused until there are no upcoming appointments.

### Where to set it in the app

Doctor, Availability: *Weekly working hours* (each session has Scheduling = Stream or Wave, slot length, and patients per
slot for Wave), *One-time sessions* (the same options for one date) and *Date exceptions* (day off, block part of the day, or
different hours). Patients see the slot length and, for Wave, the places left in each slot on the booking page.

### Receptionist front desk

A receptionist (role `RECEPTIONIST`, linked to a clinic in `receptionist_assignments`) signs in to **Front desk** (`/reception`).
It shows live slot availability for the doctors of their clinic (Stream: Available/Booked; Wave: "2/3 available", then "Full";
refreshed every few seconds) and lets them book, reschedule and cancel for a **registered** patient, found by name, email or phone.

- It calls the patient's own booking, reschedule and cancel code (`AppointmentsService.bookFor`, `rescheduleFor`, `cancelFor`):
  the same transaction, doctor row lock, slot rules, seats and database guards, so a receptionist and a patient racing for the
  last place can never overbook a slot. Nothing about slots is computed again in the receptionist module.
- Every doctor and appointment is checked against the receptionist's clinics first (`403` for another clinic's doctor, `404` for
  another clinic's appointment). Booking records the receptionist in `booked_by_user_id`.
- A receptionist's booking is **confirmed at once and the fee is paid at the clinic**: it skips the online payment hold. A patient's
  own online booking is unchanged.
- Endpoints (`RECEPTIONIST` only): `GET /api/receptionist/doctors`, `GET /api/receptionist/patients?search=`,
  `GET /api/receptionist/appointments?date=&doctorId=`, `POST /api/receptionist/appointments`,
  `POST /api/receptionist/appointments/:id/cancel`, `POST /api/receptionist/appointments/:id/reschedule`.
- Receptionists are created and assigned by an **administrator** (see "Administrators and receptionists" in the README): one clinic
  each, and they choose their own password from an emailed one-time link. Public sign-up cannot create them.

### Changing hours after bookings (elastic scheduling)

A doctor can extend or reduce the hours of an existing session (**Doctor, Availability, Your availability, Adjust hours**) for
Wave and Stream, recurring and non-recurring. Slot length, places per slot and the Stream session cap never change; only the
hours do. Everything is previewed first, from the same engine patients are offered slots from, run once with the current hours and
once with the proposed ones: the hours now and proposed, the slots that appear or go, and anything that is refused.

- **Extending** adds only the new slots. Existing slots, bookings and seats are untouched, and the new time is bookable at once.
  The end can move freely (the extra time must hold at least one slot). The start must move in whole steps of the slot grid
  (the slot length, or the interval for a Stream session of the doctor's own length), otherwise every existing slot would shift;
  the preview refuses and offers the nearest start times that work.
- **Reducing** works out which booked appointments end up outside the new hours (they were inside the hours before, and are not
  afterwards) and lists every one before anything is saved, each with other open times it could move to. Saving needs the doctor's
  explicit agreement. Then:
  - new bookings in the removed time stop at once;
  - **every affected appointment stays booked.** Nothing is moved, changed or cancelled automatically;
  - each affected patient is emailed (and texted when SMS is set up) and asked to choose a new time. The link opens the normal
    reschedule page, where the patient confirms the move themselves; the doctor may suggest one of the open times;
  - the appointment shows "needs a new time" to the patient and appears under **Appointments outside your hours** for the doctor,
    who can ask again (at most once a day) and, only as a last resort, cancel it with the usual reason, notice and refund.
- **Recurring sessions** change from a chosen date (today by default). The old row ends the day before and a new row starts, so
  earlier dates keep exactly the hours they had, and appointments from that date on follow the new row. Rows that ended this way
  are history: they are never shown, edited or counted, and saving the weekly hours does not delete them.
- **Non-recurring sessions** change only their own date. **Date exceptions** (a day off, a blocked time, replacement hours) are
  never touched, and a date they decide comes out unaffected, because they already rule that day.
- **Safety:** applying takes the doctor row lock that bookings take and re-checks the plan inside the transaction, so a booking in
  flight either lands first (and is counted, and recorded) or waits and sees the new hours; sending a change twice applies it once;
  a change made against hours that have since changed is refused.
- An appointment is "outside the hours" when it is not inside any working session of its date (not on the slot grid, so changing
  the slot interval never makes anyone outside). The same rule flags appointments left behind by a day off.
- Endpoints (doctor only): `POST /doctor-portal/availability/:id/change/preview`, `POST /doctor-portal/availability/:id/change`,
  `GET /doctor-portal/appointments/outside-hours?cursor=&limit=` (a page at a time), `POST /doctor-portal/appointments/:id/ask-new-time`,
  `GET /doctor-portal/schedule-changes` (recent reductions and how they stand). Patients: `GET /appointments/mine` gains
  `needsNewTime`, and `GET /appointments/:id/alternatives` lists the open times they can move to.

#### Reducing hours: how it holds up (migration 011)

State model. No new appointment status exists: an affected appointment stays `CONFIRMED` (or `PENDING` while unpaid) and keeps its
payment. What it *is* comes from the facts around it:

| What the people see | Where it comes from |
| --- | --- |
| Normal confirmed | `CONFIRMED`, inside the hours |
| Needs a new time | active, and outside the hours as they stand now |
| Patient asked | a `needs-new-time` message exists for it (state shown: queued / sent / failed) |
| Reschedule confirmed | old row `CANCELLED` "Rescheduled by patient", a new `CONFIRMED` row linked by `rescheduled_from_id`, payment moved |
| Cancelled | `CANCELLED` by the existing cancel (refund and notice as usual) |

Audit. `schedule_changes` has one row per applied change (who, which row, from when, old and new hours, how many were affected).
`schedule_change_appointments` has one row per affected appointment: when the patient was asked (`notified_at`), failed attempts,
the time the doctor suggested, and how it ended (`RESCHEDULED`, `CANCELLED`, `COVERED` when the hours were widened again, `CLOSED`
otherwise). Both are written in the same short transaction as the change; neither touches appointments or payments.

Notices. The request sends nothing. A background job (every 30 s, plus one immediate pass after a change) claims up to 200 unsent
rows with `FOR UPDATE SKIP LOCKED`, skips and closes any appointment that is inside the hours again, skips a patient already asked
in the last 24 hours (a notice that is queued or sent counts; one withdrawn unsent does not, see below), and puts the rest into the existing notification outbox with
a dedupe key per appointment and change. Each patient is queued in its own savepoint, so one failure rolls back only itself: it is
counted (`attempts`), retried on the next pass, and after 5 tries left visible to the doctor ("Waiting to be asked") who can ask
manually. The outbox dispatcher then sends; no database transaction is ever open while mail or text goes out. A second server
running the same job cannot double-send (SKIP LOCKED, then the dedupe key).

When nothing is open. The patient sees "No other time is open with Dr X right now. Your appointment is still booked", can check
later, contact the clinic or cancel (the existing cancel and refund rules). The doctor sees the same appointment with no times and
an **Add a one-time session** shortcut, which opens the one-time form on that date. Recurring schedules are never changed by it.

#### Extending hours: releasing the appointments that were waiting

Extending adds slots, as above, and also settles the bookkeeping a reduction left behind. Whether an appointment "needs a new time" is
always worked out from the hours as they stand now, so the patient's and the doctor's screens correct themselves the moment the
hours widen. What needs following up is the record (`schedule_change_appointments`) and any "choose a new time" message that has
not been sent yet. `reconcileCoverage` (`scheduling/schedule-reconciler.ts`) does that:

- It looks only at one doctor's upcoming, still-active appointments that have an open record or a queued message. For each one
  that is **inside the hours again** it closes every open record as `COVERED` and cancels the queued message with the reason
  "Not sent: the appointment is within the doctor's hours again." Nothing else is written: appointments, payments and refunds are
  never read or changed, and a record that already ended (`RESCHEDULED`, `CANCELLED`, `CLOSED`, `COVERED`) is never touched, so a
  completed reschedule or cancellation is never reverted.
- **When it runs.** Inside the transaction that applies an extension (or the extending side of a mixed change), under the doctor
  row lock, so nobody sees the new hours with the old bookkeeping. It also runs when hours widen any other way: adding a one-time
  session (the usual fix for a patient with nowhere to go), saving wider weekly hours, replacing a date with different hours, or
  removing a date exception. A background sweep (each notifier pass) repeats it for every doctor with something waiting, so a
  request too large to finish, or hours changed outside the application, are still caught within about 30 seconds.
- **Partial extension.** Only appointments the new hours really reach are released; the rest stay recorded, stay queued or asked,
  and keep waiting. "Reach" means inside one working session of that date and clear of any blocked time, the same rule that
  stranded them. A recurring extension from a later date releases only appointments from that date on.
- **Preview.** An extension that would release anyone lists them ("N booked appointments are back inside your hours") before the
  doctor saves; the result of a save, and the history list, report how many were released.
- **Notices.** Besides withdrawing queued messages, the sender re-checks a "choose a new time" message just before sending: if the
  appointment has since been moved, cancelled, has started, or is inside the hours again, the message is cancelled instead of sent.
  A message withdrawn unsent does not count as having asked the patient, so a later reduction asks them as normal; one that was
  sent still prevents a repeat within 24 hours.

Edge cases:

| Case | Result |
| --- | --- |
| Patient already asked (email sent), then hours widen | Record becomes `COVERED`; the email already sent stays sent and the appointment is unchanged. The patient's page says nothing is needed. |
| Hours widen before the patient was asked | Record `COVERED`; nobody is asked. |
| Reduction, then an extension that reaches only some of them | Those are released; the rest keep waiting and are asked as usual. |
| Patient already rescheduled, or the appointment was cancelled | Record keeps `RESCHEDULED` / `CANCELLED`; the new appointment and any payment are untouched. |
| Date exception: a day off, or a blocked time that covers the appointment | Not released: the exception rules that date whatever the weekly hours say. |
| Date exception removed, or replacement hours that cover it | Released. |
| Extension from a later date, or a one-time session | Only appointments on dates the new hours apply to. |
| Unpaid hold that has lapsed, or an appointment that has already started | Not considered (nothing is waiting on them). |
| Same change sent twice, or sent while bookings arrive | The doctor row lock serialises them: one applies, the other is refused as "changed since you previewed"; each booking lands before or after. |
| Extension racing the background notifier | The extension waits for the batch the notifier holds (the notifier never waits on it), then closes the record and withdraws the message the notifier just queued. |
| Message being sent at the very instant of the extension | Cannot be recalled; the record is still `COVERED`. The only case in which a released patient can receive the email. |
| Extension, then a reduction again | New records are created; the earlier `COVERED` ones stay as history. |

History is never rewritten: `schedule_changes` and `schedule_change_appointments` rows are only inserted or closed, never deleted.
No schema change was needed: `EXPAND` and `COVERED` were already allowed by migration 011. The number released by a given extension
is read from the records closed in the same transaction (`resolved_at` equals the change's `created_at`).

#### Algorithms (inputs, outputs, cost, why)

N = the doctor's active appointments in the booking window, R = removed time ranges, K = candidates, S = slots per day,
D = distinct dates, B = batch size.

| Job | Approach | Time | Space | Why / where |
| --- | --- | --- | --- | --- |
| Which appointments fall outside | The database narrows to this row's weekday, effective dates, inside its old window and sticking out of the new one (an index range scan on the existing `uq_active_slot_seat`), then the exact rule (`isCovered` before and not after, with date exceptions) decides each candidate | O(log N + K) for the scan, O(K x S) for the exact check | O(K + D x S) | The exact rule is the same engine patients are offered slots from, so a preview cannot disagree with booking; SQL only prunes, so it is never the source of truth |
| Outside-hours list for the doctor | Keyset scan in date order, 500 rows per step, stop when the page is full | O(page + log N) per page | O(500) | No offset, no repeats or gaps, memory does not grow with N |
| Alternatives for a patient | Walk days forward from the appointment's date, cut slots with the booking engine, stop at 8 (patient) or 5 (doctor list); booked windows are read 7 days at a time and cached | O(days visited x S), early exit | O(limit + days cached) | Lazy and bounded; the database still decides at confirm, so a stale list can only lose a race, never overbook |
| Notifying | Batch of 200 with SKIP LOCKED, set-based updates (`unnest`) | O(B log N) per pass | O(B) | Predictable load, restart-safe, parallel-safe |
| Releasing after an extension | Per doctor: keyset scan of upcoming active appointments that have an open record or queued message, 500 per step (4 steps in a request, 10 in the sweep); exact hours check; one `UPDATE` to close records and one to cancel queued messages | O(W log N + W x S), W = waiting appointments | O(500) | Starts from the two small partial indexes, never the whole table; the hours check is the one used everywhere else; anything beyond a request's cap is finished by the sweep |
| Matching patients to slots | None, on purpose | n/a | n/a | Patients choose and confirm; the unique seat index and the doctor lock enforce capacity, so no assignment algorithm is needed |

#### Manual testing

1. As a doctor with a Wave session (Mon 10:00 to 12:00), have two patients book 11:00 and 11:30.
2. Availability, Adjust hours, set the end to 11:00. The preview lists both patients; tick the agreement and save.
3. Right after saving, the page shows both as "Waiting to be asked", then "Asked (email on its way)" within a minute. Nothing is cancelled.
4. As the patient: Appointments shows the notice "Doctor changed their hours..."; **Choose a new time** lists real open times;
   pick one and **Confirm move**. The old booking appears under Past as "Rescheduled" and the new one is Upcoming.
5. Shrink again before they answer: no second email within 24 hours. Remove every other open time (days off) and the patient sees
   "No other time is open"; the doctor sees **Add a one-time session**.

## 4. Cancelling and rescheduling

**Cancel** (`POST /api/appointments/:id/cancel`, optional `{ reason }`): the appointment becomes `CANCELLED` with a
reason and a timestamp. Its slot and its place in the session's capacity are free again straight away.

**Reschedule** (`POST /api/appointments/:id/reschedule`, `{ date, startTime }`): moves an upcoming appointment to
another slot with the same doctor. In one transaction the server:

1. locks the doctor row, then the appointment row;
2. checks the appointment is the patient's own, active and not yet started;
3. **releases the old slot first** by cancelling the old appointment (kept as history, reason "Rescheduled by patient");
4. checks the new slot exactly like a new booking, against capacity that no longer counts the old appointment;
5. creates the new appointment, linked to the old one through `rescheduled_from_id`.

If any step fails, everything rolls back and the original appointment is untouched. Releasing first matters: a patient
can move inside a session that is full only because of their own appointment.

**Rules enforced on the server** (never by the UI alone):

- Only the owner can change an appointment; someone else's looks like a missing one (`404`).
- Only `PENDING` or `CONFIRMED` appointments can change (`409` otherwise, for example cancelling twice).
- An appointment that has started or passed cannot change (`409`).
- A new slot must exist, be in the future, be free, fit the session's capacity and be inside the booking window.
- Choosing the same time again is rejected (`400`).

**Doctor cancel** (`POST /api/doctor-portal/appointments/:id/cancel`, `{ reason }` required, 3 to 200 characters): the
same result as a patient cancel, but only for the signed-in doctor's own appointments. The row is locked while it is
checked, and the doctor, status and time rules are enforced on the server. The reason is shown to the patient, along
with who cancelled. This is also what lets a busy doctor clear their calendar before changing slot length or clinic.

**Who cancelled** is stored with every cancellation (`cancelled_by_user_id`): the patient for their own cancels and for
the old appointment of a reschedule, the doctor for a doctor cancel.

## 5. Concurrency

- Booking, rescheduling and the slot-length change all take the **same row lock on the doctor** (`SELECT ... FOR UPDATE`),
  so they run one at a time per doctor and each sees the others' results. Inside that lock the slots are recomputed, the
  seat is chosen and the appointment inserted, in one transaction. A refused booking rolls back and leaves nothing behind.
- Cancelling locks only the appointment row, so two cancels (or a cancel racing a reschedule) cannot both succeed.
- **Database backstops** (they hold even if the lock were bypassed):
  - unique index `uq_active_slot_seat` on `(doctor_id, appointment_date, start_time, slot_number)` for active appointments;
  - CHECK `ck_appointment_seat`: `slot_number` is between 1 and `slot_capacity`;
  - exclusion constraint `ex_appointments_no_overlap` (where migration 007 could add it): two active appointments of one
    doctor may not hold the same seat while their times overlap.

  Together: a slot never holds more patients than it has seats, and a STREAM slot (one seat) never holds two.
- A full slot is answered with **HTTP 409**: "That time slot has just been booked" (STREAM) or "That time slot is full:
  every place in it has been booked" (WAVE), whether it was caught by the application check or by the database.

## 6. Data changes

Migration `011_schedule_changes.sql` (additive: two new tables and three indexes, nothing existing is altered, safe on a live
database; old code ignores it). Rollback: `DROP TABLE schedule_change_appointments; DROP TABLE schedule_changes;`.

- `schedule_changes`: the audit row of each applied change of an availability row's hours.
- `schedule_change_appointments`: one row per appointment a reduction left outside the hours, primary key
  `(change_id, appointment_id)`, with `notified_at`, `attempts`, the doctor's suggested time, and `resolved_at` + `resolution`
  (a CHECK keeps the two in step). A partial index holds only the rows still waiting to be asked, and another finds the open rows of
  one appointment. Changes made before this migration have no rows; their appointments are still found and shown, because the
  doctor's list is worked out from the current hours.

Migration `010_wave_stream_scheduling.sql` (additive; rollback steps are in its header):

- `availability`: `recurrence_type`, `specific_date`, `slot_duration_minutes` (backfilled from the doctor's length; NULL still
  means "the doctor's length"), `capacity_per_slot`, `effective_from`, `effective_to`. `day_of_week` and `capacity` become
  nullable. CHECKs: WEEKLY needs `day_of_week` and no date; ONE_TIME needs a date and no weekday; `end_time > start_time`;
  `capacity_per_slot > 0`; `slot_duration_minutes > 0`; STREAM means capacity per slot 1; effective range not backwards.
- `appointments`: `availability_id` (foreign key, `ON DELETE SET NULL` so replacing availability never deletes or invalidates
  an appointment), `slot_capacity`, `slot_number`. Existing appointments are seat 1 of 1. `availability_id` is backfilled
  best-effort: the one weekly row covering the start time, only on days without a date exception; otherwise it stays NULL.
- The unique index on `(doctor, date, start_time)` becomes one that includes the seat, and the overlap constraint from 007
  becomes per seat. With every existing row on seat 1 these are exactly the old rules, so they cannot fail on existing data.
- `schedule_overrides`: a CHECK that an unavailable exception has both times or neither.

Saving the weekly hours again keeps the id of every row that did not change, so appointments stay linked to their row.


Migration `004_cancelled_by.sql` adds `appointments.cancelled_by_user_id` and a check that a cancelled appointment always
says who cancelled it. Before it existed only patients could cancel, so earlier cancellations are attributed to the
appointment's patient.

Migration `002_cancel_and_reschedule.sql` adds `appointments.cancelled_at` and `appointments.rescheduled_from_id`, plus a
check that a cancelled appointment has a timestamp. It only adds columns, so existing data is untouched.

## 7. Tests

Run from `backend/`: `npm test` (unit) and `npm run test:e2e` (real PostgreSQL test database).

- **Unit** (`slots.spec.ts`, `appointment-rules.spec.ts`, `availability-rules.spec.ts`): session resolution, slot generation,
  capacity and `FULL`/`PAST` marking; weekly, one-time, precedence, override and partial-day rules; WAVE capacity; seats;
  invalid rows (time ranges, recurrence combinations, capacity).
- **End to end** (`test/booking.e2e-spec.ts`, `test/slots.e2e-spec.ts`, `test/scheduling.e2e-spec.ts`):
  - booking, taken slots, capacity limits, cancellation, rescheduling and doctor settings, as before;
  - wave and stream through the real API: weekly and one-time availability, precedence, overrides and partial-day blocks,
    WAVE capacity reached (409), STREAM slot already booked (409), validation errors, and the database CHECKs;
  - concurrency: 8 patients booking one WAVE slot of 3 (exactly 3 succeed, 5 get 409, seats 1-3), 8 patients on one STREAM
    slot (exactly 1), and two WAVE slots raced at once.

- **Extending after a reduction** (`test/expand-resolve.e2e-spec.ts`, `findRestored` in `elastic.spec.ts`): releasing notified and un-notified patients, partial extension, never reverting a reschedule or cancellation, payments untouched, history kept, date exceptions, recurring and one-time sessions, repeated reductions and the 24-hour rule, the sender's last-moment check, two identical extensions at once, an extension racing the notifier (held mid-batch), and the background sweep. `scripts/load-elastic.mjs` also runs a 400-patient reduction followed by partial and full extensions with bookings racing them and a held outbox.

Checked by mutation: breaking seat assignment, the capacity count, precedence order, the partial-day block, the STREAM
capacity rule or effective dates makes tests fail. Removing the doctor lock from booking (both places) makes the WAVE race
tests fail on every run; the STREAM race still passes then, because the database's unique index alone stops a double booking.

The same walk-through for extending hours, with the database checks, is in `docs/manual-test-expansion.md`.

## 8. Known limitations

- Doctors can cancel appointments but cannot move them to another time; only patients and receptionists reschedule.
- A patient is not emailed or texted when a doctor cancels. They see it on their dashboard and in their history.
- A patient reschedules with the **same doctor** only. Another doctor is a new booking.
- No cancellation deadline (for example "at least 2 hours before"). Anything that has not started can be changed.
- Changing availability never moves or cancels existing appointments. When hours are reduced they stay booked until each patient chooses a new time (see above). When hours are extended again, patients who were waiting and are covered are released without any action.
- A message already being sent when the hours are extended cannot be recalled, so that one patient may still receive a "choose a new time" email for an appointment that no longer needs it.
- An appointment that straddles two adjacent sessions counts as outside the hours, even though the working time is continuous.
- Records for appointments the patient moved or the doctor cancelled are closed by the next background pass (up to about 30 seconds), not instantly.
- A date exception that replaces the day cannot choose its own mode or slot length; it inherits them (see section 2).
- Lowering `capacity_per_slot` below the patients already booked keeps those bookings; the slot simply shows no free seats.
- There is no arrival or queue rule inside a WAVE slot: patients share the slot, and the order within it is up to the clinic.
