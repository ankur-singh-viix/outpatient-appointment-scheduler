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

**Recommendation for CareSlot: keep the current hybrid.** Every patient gets their own slot (stream), and each working
session has a capacity cap (a wave-style limit on the load). That gives patients an exact time and still stops a
session from being overloaded. It is already built and tested.

A true wave mode (several patients in one slot, with arrival windows or a queue) is a different feature. The database
already reserves room for it (`scheduling_mode` is `STREAM` or `WAVE`), but nothing uses `WAVE` yet, and it is only
worth building if a clinic needs it.

## 2. How availability is worked out

For a doctor and a date, the server (`backend/src/scheduling/`):

1. Picks the working **sessions**: a date exception replaces the weekly hours; a day off means none. A missing
   capacity falls back to the doctor's default.
2. Splits each session into **slots** of the doctor's slot length (`consultation_minutes`).
3. Marks each slot:
   - `BOOKED`: an active appointment starts at that time.
   - `FULL`: the session already holds as many active appointments as its capacity.
   - `PAST`: the slot starts at or before now (in the clinic time zone).
   - `AVAILABLE`: otherwise.

"Active" means `PENDING` or `CONFIRMED`. Cancelled, completed and no-show appointments do not occupy a slot or count
toward capacity. The same function lists slots and validates a booking, so what a patient sees is what the server accepts.

## 3. Doctor configuration (already working, now complete)

| Setting | Where | Notes |
|---|---|---|
| Working days, session start and end | Doctor dashboard → Availability → Weekly working hours | Overlapping sessions on a day are rejected. Each session must fit at least one slot. |
| Capacity per session | Same editor | 1–200 bookings per session. |
| Day off or different hours for one date | Date exceptions | Replaces the weekly hours for that date. |
| **Slot length** | Availability → Slot length | **New.** 5–120 minutes. Refused while upcoming appointments exist, or when a session would be shorter than the new length. |

All of it is stored in PostgreSQL and shows up immediately in patient availability.

Why slot length is locked while appointments exist: an appointment keeps its own start and end time. A longer slot
could overlap an existing booking, so the change is refused until there are no upcoming appointments.

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

- Booking, rescheduling and the slot-length change all take the **same row lock on the doctor** (`SELECT … FOR UPDATE`),
  so they run one at a time per doctor and each sees the others' results.
- Cancelling locks only the appointment row, so two cancels (or a cancel racing a reschedule) cannot both succeed.
- A partial unique index on `(doctor_id, appointment_date, start_time)` for active appointments is the final backstop
  against double booking.

## 6. Data changes

Migration `004_cancelled_by.sql` adds `appointments.cancelled_by_user_id` and a check that a cancelled appointment always
says who cancelled it. Before it existed only patients could cancel, so earlier cancellations are attributed to the
appointment's patient.

Migration `002_cancel_and_reschedule.sql` adds `appointments.cancelled_at` and `appointments.rescheduled_from_id`, plus a
check that a cancelled appointment has a timestamp. It only adds columns, so existing data is untouched.

## 7. Tests

Run from `backend/`: `npm test` (unit) and `npm run test:e2e` (real PostgreSQL test database).

- **Unit** (`slots.spec.ts`, `appointment-rules.spec.ts`): session resolution, slot generation, capacity and `FULL`/`PAST`
  marking, and the rule for when an appointment may still change.
- **End to end** (`test/booking.e2e-spec.ts`):
  - session configuration persists and drives availability, including different capacities per session;
  - booking, taken slots, capacity limits and an 8-way concurrent booking test;
  - cancellation frees the slot and capacity, and the freed slot can be booked again;
  - rescheduling: release and move, moving inside a full session, rejected moves leave the original untouched,
    two patients racing for the last place (exactly one wins), five concurrent moves into a capacity-2 session
    (exactly two win), and a cancel racing a reschedule;
  - invalid requests: bad ids, unknown fields, wrong owner, wrong role, no token, past appointments, out-of-window dates;
  - slot length: validation, regenerated slots, refusal with upcoming appointments or sessions that are too short.

Checked by mutation: removing the doctor lock from the reschedule step makes both reschedule race tests fail, and
restoring it makes them pass.

## 8. Known limitations

- Only stream slots with a session capacity cap. True wave blocks (several patients per slot) are not implemented.
- Doctors can cancel appointments but cannot move them to another time; only patients reschedule.
- A patient is not emailed or texted when a doctor cancels. They see it on their dashboard and in their history.
- A patient reschedules with the **same doctor** only. Another doctor is a new booking.
- No cancellation deadline (for example "at least 2 hours before"). Anything that has not started can be changed.
- Changing weekly hours does not move or cancel existing appointments. They stay on the dashboard.
- No email or SMS notifications for cancellations or reschedules.
