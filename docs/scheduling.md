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

Checked by mutation: breaking seat assignment, the capacity count, precedence order, the partial-day block, the STREAM
capacity rule or effective dates makes tests fail. Removing the doctor lock from booking (both places) makes the WAVE race
tests fail on every run; the STREAM race still passes then, because the database's unique index alone stops a double booking.

## 8. Known limitations

- Doctors can cancel appointments but cannot move them to another time; only patients reschedule.
- A patient is not emailed or texted when a doctor cancels. They see it on their dashboard and in their history.
- A patient reschedules with the **same doctor** only. Another doctor is a new booking.
- No cancellation deadline (for example "at least 2 hours before"). Anything that has not started can be changed.
- Changing availability does not move or cancel existing appointments. They stay on the dashboard.
- A date exception that replaces the day cannot choose its own mode or slot length; it inherits them (see section 2).
- Lowering `capacity_per_slot` below the patients already booked keeps those bookings; the slot simply shows no free seats.
- There is no arrival or queue rule inside a WAVE slot: patients share the slot, and the order within it is up to the clinic.
