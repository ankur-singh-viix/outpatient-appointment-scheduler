# CareSlot: UI and features plan

A planning document for the CareSlot outpatient appointment scheduler. It says what the product should do, how it
should look, what the database must grow to support, and in what order to build it.

**Scope:** an outpatient clinic scheduler (find a doctor, book a visit, manage the schedule). **Video consultations
are out of scope.** The MVP is kept deliberately small.

**Tags used throughout**

| Tag | Meaning |
|---|---|
| **Done** | Already built and working in this repository |
| **MVP** | Small, practical, needed for a credible first release |
| **V2** | Valuable, built after the MVP is solid |
| **Later** | Worth recording, no commitment |

## 1. Where the project stands today

Built and tested: doctor directory with search and specialty filters; doctor profile with date and slot picker; booking
with server-side capacity rules; patient "My appointments"; cancel and reschedule; doctor dashboard with day navigation;
doctor weekly sessions, capacity, date exceptions and slot length; JWT login with role checks; PostgreSQL through TypeORM;
unit and end-to-end tests including concurrent booking.

Not built: symptom search, family bookings, receptionist and admin screens, walk-ins, wave scheduling,
notifications. Those are what this plan covers.

## 2. Patient UI

| Area | Feature | Tag | Notes |
|---|---|---|---|
| Search | Search by doctor name or specialty | Done | Debounced; filter chips per specialty |
| Search | **Symptom search** ("fever", "skin rash" suggests General Physician, Dermatology) | MVP | A small curated symptom-to-specialty list, not a diagnosis. Shows a clear "this is not medical advice" line |
| Search | Filter by clinic or area; sort by fee | MVP | Fee sort is Done; area needs `clinics.city` (see section 7) |
| Search | **Next available slot** on every doctor card | Done | Computed with the same rules as booking. Filtering by "available today" is still V2 |
| Doctor cards | Avatar, name, specialty, clinic, fee, visit length, timings, bio, View profile / Book | Done | Real data only. No invented credentials or ratings |
| Doctor cards | Qualifications and years of experience as separate fields | MVP | Today they live inside the free-text bio |
| Profile | Bio, clinic, fee, timings, date strip, slots grouped by session | Done | |
| Profile | Languages spoken; clinic map link | V2 | |
| Booking | Date, slot, review, confirm, success | Done | Slot states are labelled, not colour only |
| Booking | **Patient sign-up**, email verification, role choice and profile | Done | Pending sign-ups live in `email_verifications`; the user rows are created only after the profile step |
| Booking | Reason for visit (short note to the doctor) | V2 | One nullable column |
| Appointments | Upcoming and Past tabs, status badges | Done | |
| Appointments | **Reschedule and cancel** with confirmation | Done | Same doctor only; old slot released; history kept |
| Appointments | Cancellation deadline (for example 2 hours before) | V2 | Per-clinic setting |
| Appointments | Email or SMS reminders | Later | Needs a provider and a `notifications` table |
| **Family bookings** | Book for a parent, child or partner from one account | V2 | See `family_members` in section 7. Booking screen gets a "Who is this for?" step |
| Account | Patient profile editing and change password | V2 | Doctors can already edit their profile |

**Principle:** a first-time visitor should reach "booked" in under a minute, signed out until the last step.

## 3. Doctor and receptionist portal

| Area | Feature | Tag | Notes |
|---|---|---|---|
| Sessions | Weekly working hours, several sessions per day | Done | Overlaps rejected |
| Capacity | Capacity per session | Done | Enforced on the server, including under concurrency |
| Overrides | Day off or different hours for one date | Done | |
| Slot length | Doctor sets slot length | Done | Refused while upcoming appointments exist |
| Daily schedule | Day navigation, patient name and phone, status, "New" badge | Done | |
| Profile | Doctor edits name, specialty, clinic, fee and bio | Done | A clinic change is refused while upcoming appointments exist |
| Daily schedule | Mark an appointment **Completed** or **No-show** | V2 | Statuses already exist in the database; needs two buttons and permission checks |
| Daily schedule | Doctor cancels an appointment (with a reason shown to the patient) | Done | Reason, time and canceller are stored; unblocks slot-length changes for busy doctors |
| Receptionist | Receptionist signs in and sees the doctors of **their clinic** | V2 | `receptionist_assignments` already links receptionists to clinics |
| Receptionist | Book, reschedule and cancel on behalf of a patient | V2 | `booked_by_user_id` already records who booked |
| **Walk-ins** | Receptionist adds a patient who arrives without booking | V2 | Takes the next free slot, or an extra place if the session has room. Needs a way to record patients without an account (section 7) |
| Wave scheduling | Several patients per block | Later | See below |

### Stream vs wave: decision

- **Stream:** one patient per slot, in order. Exact times, little waiting, but no-shows leave gaps.
- **Wave:** several patients per block up to a capacity. Absorbs no-shows and overruns, but needs arrival rules or a queue.

**Decision:** keep **stream slots with a session capacity cap** (what is built). Patients get an exact time, and a session
still cannot be overloaded. Walk-ins fit this model: they use spare session capacity. True wave blocks stay **Later**,
because they also need a queue or token screen at the clinic. The `scheduling_mode` column already exists, so the schema
will not block it. See [scheduling.md](scheduling.md).

## 4. Admin features

Keep admin small: the goal is to run a demo clinic without editing the database by hand.

| Feature | Tag | Notes |
|---|---|---|
| Admin role and sign-in | V2 | The `ADMIN` role already exists |
| Manage clinics (name, address, city) | V2 | Uses the `clinics` table |
| Manage specialties and the symptom list | V2 | Uses `specialties`; symptom tables are new |
| Add a doctor (user, profile, clinic, specialty, fee, slot length) | V2 | Today doctors come from the seed script |
| Assign receptionists to clinics | V2 | `receptionist_assignments` |
| Deactivate a doctor or user | V2 | Needs an `is_active` flag |
| Read-only reports (bookings per day, cancellations, no-shows) | Later | Simple SQL counts first |
| Audit log of who changed what | Later | |

## 5. UI improvements (cross-cutting)

- **MVP:** sign-up form; keyboard and screen-reader checks on every new screen (the project already scans with axe);
  a "booked slots stay visible" rule on the picker; clear error text for every failed request.
- **V2:** a month calendar for dates beyond the 14-day strip; skeleton loading on every list; dark theme using the same tokens.
- **Later:** installable web app (PWA) for patients; localisation.

## 6. CareSlot design system (original)

**Inspiration, not imitation.** The layout patterns come from general doctor-directory and medicine-ordering apps:
a prominent search, a card per doctor, grouped time slots, a sticky summary. **No branding, copy, icons, illustrations or
images from any existing product are used.** CareSlot's name, colours, wording and icons are its own. (No reference
screenshots were available when this was written. If some are added later, they should inform layout only.)

**Personality:** calm, clear, trustworthy. Medical products fail when they feel noisy. Use one brand colour, generous
spacing, and plain language.

### Tokens

All tokens are CSS variables in `frontend/app/globals.css`, exposed to Tailwind through `@theme`, so components never
hard-code colours.

| Token group | Decision |
|---|---|
| Brand | Deep teal primary (`--primary`) with a soft teal tint (`--accent`) for selected and highlighted areas |
| Neutrals | Cool grey background (`--background`), white cards (`--card`), slate text (`--foreground`, `--muted-foreground`) |
| Status | Confirmed = green, Pending = amber, Cancelled = slate, Completed = blue, No-show = red. Each pairs colour with a **text label** |
| Danger | A dark red (`--destructive`) chosen to pass 4.5:1 contrast on its tinted background |
| Type | Geist, one family. Page title 30 to 36 px bold; section title 18 px semibold; body 14 to 16 px; small 12 to 13 px |
| Spacing | 4 px base; cards use 20 px padding; page gutter 16 px on phones |
| Radius | `--radius` 10 px; larger on cards, full on chips and avatars |
| Elevation | Mostly flat with a hairline ring. Shadow only for floating things (the search card, hover) |
| Motion | 150 to 300 ms fades and small slides; disabled for users who ask for reduced motion |

### Components and rules

- **Built on shadcn/ui:** button, card, input, label, badge, tabs, alert, skeleton, table, radio group. Add a component
  only when a screen needs it.
- **Slot states:** Available (outlined), Selected (solid with a tick), Booked (struck through, labelled), Full (amber,
  labelled), Passed (faint, labelled). Never colour alone.
- **Every list has four states:** loading (skeleton or spinner), empty (icon, one sentence, one action), error (message
  and a retry), and content.
- **Accessibility floor:** WCAG AA contrast, visible focus rings, real headings, labelled controls, no horizontal scroll at 390 px.
- **Wording:** short, active and kind. "Cancel this appointment? The slot will be released for other patients."

## 7. Future database and schema requirements

The existing nine tables are `users`, `patients`, `doctors`, `clinics`, `specialties`, `receptionist_assignments`,
`availability`, `schedule_overrides` and `appointments` (see [er-diagram.md](er-diagram.md)).

| Change | Tag | Why |
|---|---|---|
| `appointments.cancelled_at`, `appointments.rescheduled_from_id` | **Done** | Cancel and reschedule history |
| `doctors.qualifications` (text) and `doctors.experience_years` (int) | MVP | Show real credentials on cards and profiles |
| `clinics.city` (and optional `area`) | MVP | Filter doctors by location |
| `symptoms (id, name)` and `symptom_specialties (symptom_id, specialty_id)` | MVP | Symptom search. Seeded, curated, small |
| `email_verifications` (pending sign-ups, hashed password and code) | **Done** | Migration 003. Patient sign-up itself needed no other schema change |
| `appointments.visit_reason` (text, nullable) | V2 | Note to the doctor |
| `family_members (id, patient_id, name, relation, date_of_birth, gender)` and `appointments.family_member_id` (nullable) | V2 | Booking for family. The account holder stays the booker |
| `appointments.source` enum (`ONLINE`, `WALK_IN`, `PHONE`) | V2 | Tell walk-ins apart in reports |
| Patients without an account: `patients.user_id` nullable plus `name` and `phone` on `patients` | V2 | Walk-ins by a receptionist |
| `doctors.is_active`, `users.is_active` | V2 | Deactivate instead of delete |
| `clinics.cancellation_cutoff_minutes` | V2 | Cancellation deadline |
| `appointments.completed_at` | V2 | When a doctor marks a visit done |
| `availability.slot_capacity` (patients per slot) | Later | Real wave scheduling |
| `appointments.token_number`, `checked_in_at` | Later | Waiting-room queue |
| `notifications (id, user_id, kind, payload, sent_at)` | Later | Email and SMS reminders |
| `audit_log (id, actor_user_id, action, entity, entity_id, at)` | Later | Admin accountability |
| `reviews`, `payments` | Later | Out of the first versions |

**Rules for every migration:** a new numbered SQL file under `backend/db/migrations`; add columns only (never drop data);
keep existing tests green; update the ER diagram in the same change.

## 8. Frontend stack

| Piece | Choice | Why |
|---|---|---|
| Framework | **Next.js** (App Router) with React and TypeScript | Routing, fast production builds, deploys to Vercel |
| Styling | **Tailwind CSS** | Utility classes driven by the design tokens above |
| Components | **shadcn/ui** (code lives in `frontend/components/ui`) | Accessible primitives we own and can edit |
| Design tokens | **Custom CSS variables** in `globals.css` | One place to change colour, radius and type |
| Icons | `lucide-react` | Consistent line icons |
| Data | Plain `fetch` through a small `api()` helper and a `useQuery` hook | No extra state library until it is needed |

No new frontend dependency is needed for the MVP in this plan.

## 9. Seven-day roadmap

| Day | Focus | Deliverables | Done when |
|---|---|---|---|
| 1 | **ER diagram and NestJS setup** | ER diagram, NestJS project, Hello World, Git history | The diagram parses and `GET /` answers |
| 2 | **Auth and models** | TypeORM entities for all tables, SQL migration, seed data, JWT login, role guards | Login returns a token; wrong role gets 403 |
| 3 | **Doctor browsing and booking** | Doctor list and search, doctor profile, slot listing, booking endpoint, patient screens | A patient can find a doctor and book a slot |
| 4 | **Scheduling, reschedule, cancel** | Sessions, capacity, overrides, slot length, cancel, reschedule, doctor dashboard | Capacity holds under concurrent requests |
| 5 | **Tests** | Unit tests for slot rules, end-to-end tests on PostgreSQL, a browser walkthrough | Suites green; race tests proven by mutation |
| 6 | **Polish** | Design system pass, accessibility scan, mobile layouts, empty and error states | No axe violations; no horizontal scroll at 390 px |
| 7 | **Deployment and demo** | Neon, Render and Vercel set up; live checks; demo script | Health check, doctor list, booking and dashboard work on the live URLs |

**Next after the 7 days (MVP additions):** patient sign-up, symptom search, structured qualifications, clinic city filter.
Then V2 in this order: doctor and receptionist actions (complete, no-show, doctor cancel), walk-ins, family bookings, admin basics.

## 10. Out of scope and risks

- **Out of scope:** video or phone consultations, payments, prescriptions and medical records, insurance.
- **Risk: symptom search reads as medical advice.** Mitigation: curated mapping, visible disclaimer, no diagnosis wording.
- **Risk: walk-ins and wave scheduling both change how capacity works.** Mitigation: build walk-ins on the existing
  session capacity first; revisit wave only when a clinic needs it.
- **Risk: demo accounts share a public password.** Mitigation: patient sign-up (MVP) and removing the demo seed from any real deployment (`SKIP_DEMO_SEED=true`).
