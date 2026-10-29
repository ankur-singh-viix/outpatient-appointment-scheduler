# CareSlot: Outpatient Appointment Scheduler

Patients browse doctors, pick an open time slot and book an appointment. Doctors set their working hours and see their bookings.

| Part | Stack |
|---|---|
| `frontend/` | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, **shadcn/ui** |
| `backend/` | **NestJS** 12, TypeScript, **Zod** validation, **TypeORM** 1.1, JWT auth |
| Database | **PostgreSQL** (local Docker; **Neon** when deployed) |
| Deployment | Backend on **Render** (Railway config also included), frontend on **Vercel**, database on **Neon** |
| `docs/er-diagram.md` | Data model and design decisions |
| `docs/scheduling.md` | Scheduling approach, cancel/reschedule rules, concurrency and tests |

## Features

**Everyone**
- **Sign up with email verification:** email and password, a 6-digit code sent to that email, then a choice of **Patient** or **Doctor** and a profile form for that role. Signing in with a half-finished sign-up continues where it stopped. The password is stored only as a hash.

**Patients**
- A **dashboard** with the next appointment, quick actions and a summary of past, upcoming and cancelled visits.
- Doctor directory showing name, specialty, clinic, consultation fee, weekly timings and each doctor's **next available slot** (worked out with the same rules booking uses), with search by name or specialty and specialty filters.
- Booking in three steps: choose a date, pick a slot, then review and confirm. Slots that are booked, full or in the past are disabled.
- A confirmation screen after booking, and a **My appointments** page.
- **Cancel** an upcoming appointment (with a confirmation step) or **reschedule** it to another slot with the same doctor. The old slot is released straight away and the old appointment is kept as history under Past.

**Doctors**
- **Profile**: name, specialty, clinic, fee and bio, shown to patients straight away. Moving clinic is refused while upcoming appointments exist.
- **Cancel an appointment** from the appointment list. A confirmation dialog requires a reason; the cancel is recorded with the reason, the time and who did it. The patient sees it on their dashboard and in their history, and the time becomes bookable again.
- A **workspace layout**: a deep-teal sidebar (Dashboard, Appointments, Availability, Profile) with a compact top bar; on phones the sidebar becomes a strip under the top bar.
- A dashboard listing appointments with patient name, date, time and status. It reads from the database, so bookings stay visible after a refresh.
- **Weekly working hours**: one or more sessions per weekday, each with a capacity.
- **Date exceptions**: a day off, or different hours, for a specific date.
- **Slot length**: how long each appointment is. It can only change while there are no upcoming appointments.

**Rules enforced by the server**
- Slots are generated from the doctor's hours in consultation-length steps.
- A date exception replaces the weekly hours for that date.
- A session accepts no more than its **capacity** in bookings, and a slot can't be booked twice, even when requests arrive at the same moment.
- Only `PATIENT` accounts can book, and only `DOCTOR` accounts can use the doctor portal.
- A cancelled appointment stops counting toward its slot and its session's capacity. Only the owner can cancel or reschedule an upcoming appointment, and a reschedule is all-or-nothing: if the new slot is not valid, the original stays.

## Run it locally

Prerequisites: Node.js 24 and Docker Desktop.

```powershell
# 1. Database: PostgreSQL 17 in Docker, plus a separate test database
docker compose up -d

# 2. Backend API on http://localhost:3000
cd backend
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
npm run db:migrate          # creates the tables
npm run db:seed             # demo clinics, doctors, patients and weekly hours
npm run start:dev

# 3. Frontend on http://localhost:3001 (in a second terminal)
cd frontend
npm install
npm run dev
```

Open http://localhost:3001. `GET http://localhost:3000/` returns `Hello World!` on purpose (the original setup check); the API lives under `/api`, for example `/api/health` and `/api/doctors`.

### Signing up locally

No email provider is needed in development: the backend prints each verification email, including the 6-digit code, in its terminal (the sign-up page says so). To send real emails, set `RESEND_API_KEY` and `EMAIL_FROM` (see Deploying).

### Demo accounts

All demo accounts use the password `Demo@1234`. The login page also has one-click buttons for them.

| Role | Email |
|---|---|
| Patient | `patient@example.com` (Rahul Sharma) |
| Patient | `sneha.gupta@example.com` |
| Doctor | `ananya.rao@example.com` (General Physician, two sessions per day) |
| Doctor | `rohan.das@example.com` (ENT; capacity 3 per session, so it fills up quickly for demos) |

The other doctors are `vikram.mehta@`, `priya.nair@`, `arjun.kapoor@` and `meera.iyer@example.com`.

## Tests and checks

```powershell
cd backend
npm test            # unit tests: slot rules, next-available, cancel/reschedule rules, verification codes, email senders, config
npm run test:e2e    # API tests against the PostgreSQL test database (needs docker compose up)
npm run lint
npm run typecheck
npm run build

cd ../frontend
npm run lint
npm run typecheck
npm run build
```

The e2e suite (`backend/test/booking.e2e-spec.ts`) drops and rebuilds the schema in `TEST_DATABASE_URL`, never in your development database. It covers:

- **Availability:** doctor listing and search, slots and session capacity for a date, and invalid input.
- **Booking:** a successful booking is saved in PostgreSQL and appears on the doctor's dashboard and in the patient's list. A taken slot returns `409`, and a time that isn't a slot returns `400`.
- **Validation:** malformed bodies and unknown body fields are rejected by the Zod schemas with a readable message per problem, while unknown query parameters (such as `utm_source`) are ignored.
- **Capacity:** a session rejects bookings beyond its capacity, including **8 simultaneous requests** against a capacity of 2, where exactly 2 succeed.
- **Doctor availability:** a day off removes that date's slots, custom hours replace them, and overlapping weekly sessions are rejected.
- **Doctor cancellation:** needs a real reason (no body, empty, too short or too long, and unknown fields are refused); records the reason, the time and the cancelling doctor; frees the slot and the session capacity so someone else can book it; shows up for the patient with the reason and who cancelled; is refused for another doctor's appointment, for patients and for past, completed or already cancelled appointments; and when a doctor and a patient cancel at the same moment exactly one wins (checked by removing the row lock and the ownership filter, which makes those tests fail).
- **Roles:** no token returns `401`, a doctor trying to book gets `403`, and a patient opening the doctor portal gets `403`.
- **Cancellation:** frees the slot and capacity (the slot can be booked again), keeps a cancelled record, and rejects cancelling twice, someone else's appointment, a past appointment and invalid input.
- **Rescheduling:** releases the old slot and books the new one, works inside a session that is full only because of the appointment itself, rejects taken or full slots without touching the original, and stays correct under concurrent reschedules and a cancel racing a reschedule.
- **Sign-up:** a code is emailed and only its hash is stored; wrong codes are limited to 5 per code, codes expire after 15 minutes, resending is rate-limited, and a new code replaces the old one. A sign-up token can finish a profile but can never act as a session (checked by removing the guard and watching the test fail). Role-specific profile validation, one account per email even under double-clicks, and resuming half-finished sign-ups are covered.
- **Next available and doctor profile:** every doctor's next slot matches the first free slot the slots endpoint offers; a day off moves it later; profile edits are validated, add the "Dr." title once, and a clinic change is refused while upcoming appointments exist.
- **Doctor sessions:** weekly hours and per-session capacity persist and drive patient availability; the slot length can change only when it is valid and no upcoming appointments exist.

## API

All routes are under `/api`. Routes marked 🔒 need an `Authorization: Bearer <token>` header from `POST /api/auth/login`.

| Method | Route | Access | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Start a sign-up `{ email, password }` (8+ characters). Emails a 6-digit code. `409` if the email already has an account, `429` if a code was sent under 30 seconds ago |
| POST | `/auth/verify-email` | public | `{ email, code }`. Returns a 30-minute `signupToken`. Wrong codes are limited to 5 per code |
| POST | `/auth/resend-code` | public | `{ email }`. Sends a fresh code and invalidates the old one (30-second gap) |
| POST | `/auth/complete-profile` | 🔒 sign-up token | Create the account: `{ role: "PATIENT", firstName, lastName, phone?, dateOfBirth?, gender? }` or `{ role: "DOCTOR", firstName, lastName, specialtyId, clinicId, consultationFee, bio? }`. Returns a session |
| POST | `/auth/login` | public | Email and password; returns `{ accessToken, user }`, or `{ onboardingRequired, signupToken }` for a verified but unfinished sign-up (`403 EMAIL_NOT_VERIFIED` if not yet verified) |
| GET | `/auth/me` | 🔒 any role | Current user |
| GET | `/auth/clerk/status` | 🔒 Clerk token | Where the signed-in Clerk identity stands: `LINKED`, `ONBOARDING_REQUIRED`, `LINK_REQUIRED`, `CONFLICT` or `EMAIL_UNVERIFIED` |
| POST | `/auth/clerk/complete-profile` | 🔒 Clerk token | Create the CareSlot account for a new Clerk identity (same body as `/auth/complete-profile`). Only `PATIENT` or `DOCTOR`; `409 ACCOUNT_LINK_REQUIRED` if the verified email already has an account |
| POST | `/auth/clerk/link` | 🔒 Clerk token | `{ password }`. Links the Clerk identity to the existing account with that verified email, only after proving that account's CareSlot password. Five wrong attempts lock it for 15 minutes |
| GET | `/specialties` | public | Specialty filter options |
| GET | `/clinics` | public | Clinics a new doctor can join |
| GET | `/doctors?search=&specialtyId=` | public | Doctor directory |
| GET | `/doctors/:id` | public | One doctor, with `nextAvailable` (the doctor list has it too) |
| GET | `/doctors/:id/slots?date=YYYY-MM-DD` | public | Sessions (capacity, booked, remaining) and slots (`AVAILABLE`/`BOOKED`/`FULL`/`PAST`) |
| POST | `/appointments` | 🔒 PATIENT | Book `{ doctorId, date, startTime }`. Returns `201`; `409` if the slot is taken or the session is full |
| GET | `/appointments/mine` | 🔒 PATIENT | The patient's appointments, including cancelled ones |
| POST | `/appointments/:id/cancel` | 🔒 PATIENT | Cancel an upcoming appointment, optional `{ reason }`. `404` if it is not yours, `409` if it is already cancelled or has started |
| POST | `/appointments/:id/reschedule` | 🔒 PATIENT | Move an upcoming appointment to another slot with the same doctor `{ date, startTime }`. Returns the new appointment (`201`); `409` if the slot is taken or the session is full |
| GET | `/doctor-portal/appointments?scope=upcoming\|all` | 🔒 DOCTOR | The doctor's appointments, with patient details and, for cancelled ones, the reason and who cancelled |
| POST | `/doctor-portal/appointments/:id/cancel` | 🔒 DOCTOR | Cancel one of your own upcoming appointments `{ reason }` (3 to 200 characters, required). `404` if it is not yours, `409` if it is already cancelled, completed or has started |
| GET | `/doctor-portal/availability` | 🔒 DOCTOR | Weekly hours and upcoming date exceptions |
| GET | `/doctor-portal/profile` | 🔒 DOCTOR | The doctor's own profile |
| PUT | `/doctor-portal/profile` | 🔒 DOCTOR | `{ name, specialtyId, clinicId, consultationFee, bio }`. `409` if the clinic changes while upcoming appointments exist |
| PUT | `/doctor-portal/settings` | 🔒 DOCTOR | Set the slot length `{ consultationMinutes }` (5 to 120). `409` while upcoming appointments exist |
| PUT | `/doctor-portal/availability/weekly` | 🔒 DOCTOR | Replace the weekly hours `{ hours: [{ dayOfWeek, startTime, endTime, capacity }] }` |
| PUT | `/doctor-portal/availability/overrides` | 🔒 DOCTOR | Add or replace one date's exception |
| DELETE | `/doctor-portal/availability/overrides/:date` | 🔒 DOCTOR | Remove a date exception |
| GET | `/health` | public | App and database status (`{"status":"ok","service":…,"database":"up","time":…}`); never returns configuration. Used by the hosting health check |

## Design decisions

- **TypeORM for data access, SQL migrations for the schema.** All 9 tables from the [ER design](docs/er-diagram.md) are TypeORM entities (`backend/src/database/entities/`) used through repositories, query builders and transactions. The schema itself is created by plain SQL migrations ([`001_initial_schema.sql`](backend/db/migrations/001_initial_schema.sql)), because the design relies on database features that are clearest as SQL: CHECK constraints and the partial unique index. TypeORM never alters tables (`synchronize: false`).
- **Zod for validation.** Every request body, query and route parameter has a Zod schema, applied by a small `ZodValidationPipe`. Request bodies are strict, so unknown fields are rejected. Query strings ignore unknown keys, so tracking parameters like `utm_source` never break a link, while the real parameters are still validated.
- **shadcn/ui for the interface.** Buttons, cards, inputs, tabs, tables, badges and alerts come from shadcn/ui (`frontend/components/ui/`), themed with a teal brand colour.
- **One set of slot rules for listing and booking.** [`scheduling/slots.ts`](backend/src/scheduling/slots.ts) is pure logic with unit tests. The slots endpoint and the booking transaction both use it, so what a patient sees is exactly what the server will accept.
- **Bookings can't race each other.** Booking runs in one TypeORM transaction that first locks the doctor row (`pessimistic_write`, i.e. `SELECT … FOR UPDATE`), so concurrent bookings for the same doctor run one at a time. It then recomputes the slots and capacity and inserts. The partial unique index `(doctor_id, appointment_date, start_time) WHERE status IN ('PENDING','CONFIRMED')` is the final safety net. Removing the lock makes the concurrency test fail with 3 bookings in a capacity-2 session, so the test does exercise the race.
- **Capacity follows the ER design:** a date exception takes priority, then the weekly session, then the doctor's default capacity.
- **Sign-up and email verification, without a new auth service.** Registration stores a pending sign-up (`email_verifications`, migration 003) with a password hash and a hashed code, so nothing half-created ever lands in `users`. Only after the profile step are the user and patient or doctor rows created, in one transaction. Email goes through a small `EmailSender` interface: the server log in development, Resend over HTTPS when `RESEND_API_KEY` is set (no extra package). In production with no provider, sign-up is switched off instead of printing codes into the logs.
- **Clerk sign-in, alongside the built-in login.** Clerk only proves who someone is; the `users` table still decides their role and profile. The backend verifies Clerk session tokens server-side (`@clerk/backend`) and maps them to a CareSlot user through `external_identities` (migration 005, additive). Accounts are never linked by matching email alone: the Clerk email must be verified and the person must enter the existing account's password. Roles come only from the validated form (`PATIENT` or `DOCTOR`), never from the browser's claims. Clerk is off unless `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (frontend) and `CLERK_SECRET_KEY` (backend) are set, and the original email/password login keeps working either way. Apply migration 005 (`npm run db:migrate`) before turning Clerk on. Names of the variables are in the two `.env.example` files.
- **Minimal authentication.** No auth existed before this, so login checks `users.password_hash` (Node's built-in `scrypt`) and returns a JWT that expires after 8 hours. A guard checks the role on every protected route. The frontend keeps the token in `localStorage`. That's simple, but it can be read by injected scripts if the site ever has an XSS bug. An httpOnly cookie is the next step for production. Patient sign-up, password reset and Google login aren't built yet; demo accounts are seeded instead.
- **Dates and times are clinic-local.** `date` and `time` columns are kept as strings, never converted to JS `Date`s. "Today" and "now" are worked out in `CLINIC_TIMEZONE` (default `Asia/Kolkata`).
- **The frontend calls the API directly** from the browser (CORS is limited to `CORS_ORIGIN`). Pages are client components with explicit loading, empty, error and success states.

## Deploying (Neon + Render + Vercel)

Three hosted pieces: the **database on Neon**, the **NestJS backend on Render** (Railway works too, see below), and the **Next.js frontend on Vercel**. Deploy in this order, because each step needs a value from the previous one.

1. **Database (Neon):** create a project at neon.tech and copy the **direct** connection string (not the "pooled" one), which ends in `?sslmode=require`. The migration step takes a session-level lock, which Neon's pooled endpoint doesn't support.
2. **Backend (Render):** choose *New → Blueprint* and select this repo (it reads [`render.yaml`](render.yaml)), or create a *Web Service* by hand with root directory `backend`, build command `npm install --include=dev && npm run build` and start command `npm run start:prod`.
   - **Environment variables:**
     ```
     DATABASE_URL=<the Neon direct connection string>
     JWT_SECRET=<long random string; the Blueprint generates one>
     CORS_ORIGIN=https://<your-vercel-domain>
     CLINIC_TIMEZONE=Asia/Kolkata
     RESEND_API_KEY=<optional, enables real verification emails>
     EMAIL_FROM=<optional, "CareSlot <no-reply@your-verified-domain>">
     NODE_VERSION=24.22.1
     NODE_ENV=production
     ```
     `CORS_ORIGIN` isn't known until step 3; set a placeholder now and update it afterwards. The app refuses to start in production without `JWT_SECRET`.
   - `npm run start:prod` is the whole start step: it applies pending migrations, adds any demo data that is missing, then starts the API. Seeding only inserts rows that do not exist yet and never overwrites or deletes anything, so edits survive restarts. Set `SKIP_DEMO_SEED=true` to turn the demo data off. Render health-checks `/api/health`.
   - On Render's free plan the service sleeps when idle, so the first request after a pause can take about a minute.
3. **Frontend (Vercel):** import the same repo.
   - **Root Directory:** `frontend`. The framework is detected as Next.js.
   - **Environment variables:**
     ```
     NEXT_PUBLIC_API_URL=https://<render-backend-domain>/api
     NEXT_PUBLIC_CLINIC_TIMEZONE=Asia/Kolkata
     ```
     These are baked in at build time, so redeploy after changing them.
   - Then go back to Render, set `CORS_ORIGIN` to the Vercel URL (no trailing slash) and let the backend redeploy.

**To verify:** `https://<render-backend-domain>/api/health` should return `{"status":"ok","service":"outpatient-scheduler-api","database":"up",…}` and `https://<render-backend-domain>/api/doctors` should list 6 doctors. Then open the Vercel URL, sign in as the demo patient, book a slot, sign in as that doctor and check the dashboard.

**Troubleshooting:** the site shows *0 doctors* when the database `DATABASE_URL` points at has no seed data (check that the host and database name match the Neon database you meant). The frontend build fails on purpose if `NEXT_PUBLIC_API_URL` is not set, so it can never silently call `localhost`.

**Railway instead of Render:** [`backend/railway.json`](backend/railway.json) is ready. Use root directory `/backend`, config file `/backend/railway.json`, the same variables (without `NODE_ENV`, because the build needs devDependencies), and a generated public domain. Railway runs the migrations in a pre-deploy step.

## Known limitations

- Only STREAM scheduling (one patient per slot) is implemented. The WAVE mode in the ER design is not.
- Doctors can cancel but not reschedule appointments, and patients reschedule only with the same doctor. A patient is not emailed when their doctor cancels: they see it on their dashboard and in their history. There is no cancellation deadline, and receptionist and admin screens aren't built.
- Changing weekly hours doesn't move or cancel existing appointments. They stay on the dashboard.
- **Sign-up needs an email provider in production.** Without `RESEND_API_KEY`, sign-up is disabled there (set `EMAIL_DELIVERY=log` only for a private demo: codes would appear in the server logs). The Resend sender is unit-tested against a fake HTTP call, but has not been tried against the live service.
- **Anyone with a verified email can sign up as a doctor and appear in the directory.** There is no admin approval step yet, so a real deployment would need one.
- No password reset, no per-IP rate limiting (only per-email limits), and no patient profile editing yet.
- Demo accounts share a published password, so this deployment is for demos only.
