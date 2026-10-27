# CareSlot: Outpatient Appointment Scheduler

Patients browse doctors, pick an open time slot and book an appointment. Doctors set their working hours and see their bookings.

| Part | Stack |
|---|---|
| `frontend/` | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, **shadcn/ui** |
| `backend/` | **NestJS** 12, TypeScript, **Zod** validation, **TypeORM** 1.1, JWT auth |
| Database | **PostgreSQL** (local Docker; **Neon** when deployed) |
| Deployment | Backend on **Render** (Railway config also included), frontend on **Vercel**, database on **Neon** |
| `docs/er-diagram.md` | Data model and design decisions |

## Features

**Patients**
- Doctor directory showing name, specialty, clinic, consultation fee and weekly timings, with search by name or specialty and specialty filters.
- Booking in three steps: choose a date, pick a slot, then review and confirm. Slots that are booked, full or in the past are disabled.
- A confirmation screen after booking, and a **My appointments** page.

**Doctors**
- A dashboard listing appointments with patient name, date, time and status. It reads from the database, so bookings stay visible after a refresh.
- **Weekly working hours**: one or more sessions per weekday, each with a capacity.
- **Date exceptions**: a day off, or different hours, for a specific date.

**Rules enforced by the server**
- Slots are generated from the doctor's hours in consultation-length steps.
- A date exception replaces the weekly hours for that date.
- A session accepts no more than its **capacity** in bookings, and a slot can't be booked twice, even when requests arrive at the same moment.
- Only `PATIENT` accounts can book, and only `DOCTOR` accounts can use the doctor portal.

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

Open http://localhost:3001. `GET http://localhost:3000/` still returns `Hello World!`.

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
npm test            # unit tests: slot generation, capacity rules, dates
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
- **Validation:** malformed bodies and unknown fields are rejected by the Zod schemas with a readable message per problem.
- **Capacity:** a session rejects bookings beyond its capacity, including **8 simultaneous requests** against a capacity of 2, where exactly 2 succeed.
- **Doctor availability:** a day off removes that date's slots, custom hours replace them, and overlapping weekly sessions are rejected.
- **Roles:** no token returns `401`, a doctor trying to book gets `403`, and a patient opening the doctor portal gets `403`.

## API

All routes are under `/api`. Routes marked 🔒 need an `Authorization: Bearer <token>` header from `POST /api/auth/login`.

| Method | Route | Access | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | Email and password; returns `{ accessToken, user }` |
| GET | `/auth/me` | 🔒 any role | Current user |
| GET | `/specialties` | public | Specialty filter options |
| GET | `/doctors?search=&specialtyId=` | public | Doctor directory |
| GET | `/doctors/:id` | public | One doctor |
| GET | `/doctors/:id/slots?date=YYYY-MM-DD` | public | Sessions (capacity, booked, remaining) and slots (`AVAILABLE`/`BOOKED`/`FULL`/`PAST`) |
| POST | `/appointments` | 🔒 PATIENT | Book `{ doctorId, date, startTime }`. Returns `201`; `409` if the slot is taken or the session is full |
| GET | `/appointments/mine` | 🔒 PATIENT | The patient's appointments |
| GET | `/doctor-portal/appointments?scope=upcoming\|all` | 🔒 DOCTOR | The doctor's appointments, with patient details |
| GET | `/doctor-portal/availability` | 🔒 DOCTOR | Weekly hours and upcoming date exceptions |
| PUT | `/doctor-portal/availability/weekly` | 🔒 DOCTOR | Replace the weekly hours `{ hours: [{ dayOfWeek, startTime, endTime, capacity }] }` |
| PUT | `/doctor-portal/availability/overrides` | 🔒 DOCTOR | Add or replace one date's exception |
| DELETE | `/doctor-portal/availability/overrides/:date` | 🔒 DOCTOR | Remove a date exception |
| GET | `/health` | public | Checks that the database is reachable (used by the hosting health check) |

## Design decisions

- **TypeORM for data access, SQL migrations for the schema.** All 9 tables from the [ER design](docs/er-diagram.md) are TypeORM entities (`backend/src/database/entities/`) used through repositories, query builders and transactions. The schema itself is created by plain SQL migrations ([`001_initial_schema.sql`](backend/db/migrations/001_initial_schema.sql)), because the design relies on database features that are clearest as SQL: CHECK constraints and the partial unique index. TypeORM never alters tables (`synchronize: false`).
- **Zod for validation.** Every request body, query and route parameter has a Zod schema, applied by a small `ZodValidationPipe`. The schemas are strict, so unknown fields are rejected too.
- **shadcn/ui for the interface.** Buttons, cards, inputs, tabs, tables, badges and alerts come from shadcn/ui (`frontend/components/ui/`), themed with a teal brand colour.
- **One set of slot rules for listing and booking.** [`scheduling/slots.ts`](backend/src/scheduling/slots.ts) is pure logic with unit tests. The slots endpoint and the booking transaction both use it, so what a patient sees is exactly what the server will accept.
- **Bookings can't race each other.** Booking runs in one TypeORM transaction that first locks the doctor row (`pessimistic_write`, i.e. `SELECT … FOR UPDATE`), so concurrent bookings for the same doctor run one at a time. It then recomputes the slots and capacity and inserts. The partial unique index `(doctor_id, appointment_date, start_time) WHERE status IN ('PENDING','CONFIRMED')` is the final safety net. Removing the lock makes the concurrency test fail with 3 bookings in a capacity-2 session, so the test does exercise the race.
- **Capacity follows the ER design:** a date exception takes priority, then the weekly session, then the doctor's default capacity.
- **Minimal authentication.** No auth existed before this, so login checks `users.password_hash` (Node's built-in `scrypt`) and returns a JWT that expires after 8 hours. A guard checks the role on every protected route. The frontend keeps the token in `localStorage`. That's simple, but it can be read by injected scripts if the site ever has an XSS bug. An httpOnly cookie is the next step for production. Patient sign-up, password reset and Google login aren't built yet; demo accounts are seeded instead.
- **Dates and times are clinic-local.** `date` and `time` columns are kept as strings, never converted to JS `Date`s. "Today" and "now" are worked out in `CLINIC_TIMEZONE` (default `Asia/Kolkata`).
- **The frontend calls the API directly** from the browser (CORS is limited to `CORS_ORIGIN`). Pages are client components with explicit loading, empty, error and success states.

## Deploying (Neon + Render + Vercel)

Three hosted pieces: the **database on Neon**, the **NestJS backend on Render** (Railway works too, see below), and the **Next.js frontend on Vercel**. Deploy in this order, because each step needs a value from the previous one.

1. **Database (Neon):** create a project at neon.tech and copy the **direct** connection string (not the "pooled" one), which ends in `?sslmode=require`. The migration step takes a session-level lock, which Neon's pooled endpoint doesn't support.
2. **Backend (Render):** choose *New → Blueprint* and select this repo (it reads [`render.yaml`](render.yaml)), or create a *Web Service* by hand with root directory `backend`, build command `npm install --include=dev && npm run build` and start command `npm run db:migrate:prod && npm run db:seed:prod && npm run start:prod`.
   - **Environment variables:**
     ```
     DATABASE_URL=<the Neon direct connection string>
     JWT_SECRET=<long random string; the Blueprint generates one>
     CORS_ORIGIN=https://<your-vercel-domain>
     CLINIC_TIMEZONE=Asia/Kolkata
     NODE_VERSION=24.22.1
     NODE_ENV=production
     ```
     `CORS_ORIGIN` isn't known until step 3; set a placeholder now and update it afterwards. The app refuses to start in production without `JWT_SECRET`.
   - Every start first runs the migrations and the idempotent demo seed, then the server. `npm run start:prod` also applies any pending migrations itself, so the app never starts against an empty database. Render health-checks `/api/health`.
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

**To verify:** `https://<render-backend-domain>/api/health` should return `{"status":"ok","database":"up"}`. Then open the Vercel URL, sign in as the demo patient, book a slot, sign in as that doctor and check the dashboard.

**Railway instead of Render:** [`backend/railway.json`](backend/railway.json) is ready. Use root directory `/backend`, config file `/backend/railway.json`, the same variables (without `NODE_ENV`, because the build needs devDependencies), and a generated public domain. Railway runs the migrations in a pre-deploy step.

## Known limitations

- Only STREAM scheduling (one patient per slot) is implemented. The WAVE mode in the ER design is not.
- Patients can't cancel or reschedule yet, and receptionist and admin screens aren't built.
- Changing weekly hours doesn't move or cancel existing appointments. They stay on the dashboard.
- Demo accounts share a published password, so this deployment is for demos only.
