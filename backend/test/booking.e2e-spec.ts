// End-to-end tests for the booking flow against a real PostgreSQL test database.
// Requires TEST_DATABASE_URL (see .env.example); the schema there is dropped and rebuilt.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EMAIL_SENDER, type EmailMessage } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { addDays, clinicNow, dayOfWeek } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';

const PASSWORD = 'Test@1234';
const TIME_ZONE = process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata';
// Dates a few days ahead: always in the future and inside the booking window.
const today = clinicNow(TIME_ZONE).date;
const DAY_A = addDays(today, 3);
const DAY_B = addDays(today, 4);
const DAY_C = addDays(today, 5);
const DAY_D = addDays(today, 6);

async function resetDatabase(db: pg.Client) {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(TEST_DATABASE_URL!);
}

/** One clinic, one doctor (every day 10:00-11:00, 15-minute slots, capacity 2), two patients. */
async function insertFixtures(db: pg.Client) {
  const hash = await hashPassword(PASSWORD);
  const user = async (name: string, email: string, role: string) =>
    (
      await db.query<{ id: string }>(
        'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, email, hash, role],
      )
    ).rows[0].id;

  const specialtyId = (await db.query<{ id: string }>("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id;
  const clinicId = (await db.query<{ id: string }>("INSERT INTO clinics (name, address) VALUES ('Test Clinic', '1 Test St') RETURNING id")).rows[0].id;

  const doctorUserId = await user('Dr. Test Doctor', 'doctor@test.local', 'DOCTOR');
  const doctorId = (
    await db.query<{ id: string }>(
      `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
       VALUES ($1, $2, $3, 15, 10, 650) RETURNING id`,
      [doctorUserId, clinicId, specialtyId],
    )
  ).rows[0].id;
  for (let day = 0; day < 7; day++) {
    await db.query(
      "INSERT INTO availability (doctor_id, day_of_week, start_time, end_time, capacity) VALUES ($1, $2, '10:00', '11:00', 2)",
      [doctorId, day],
    );
  }

  for (const [name, email] of [
    ['Pat One', 'patient1@test.local'],
    ['Pat Two', 'patient2@test.local'],
  ]) {
    const id = await user(name, email, 'PATIENT');
    await db.query('INSERT INTO patients (user_id) VALUES ($1)', [id]);
  }
  return { doctorId };
}

describe('Appointment booking (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let patientToken: string;
  let otherPatientToken: string;
  let doctorToken: string;

  // Stands in for real email: records what the server "sent" so tests can read verification codes.
  const sentEmails: EmailMessage[] = [];
  let failNextEmail = false;
  const mailbox = {
    send: async (message: EmailMessage) => {
      if (failNextEmail) {
        failNextEmail = false;
        throw new Error('simulated provider outage');
      }
      sentEmails.push(message);
    },
  };

  const http = () => request(app.getHttpServer());
  const login = async (email: string) =>
    (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (token: string, date: string, startTime: string) =>
    http().post('/api/appointments').set('Authorization', `Bearer ${token}`).send({ doctorId, date, startTime });
  const slotsFor = async (date: string) =>
    (await http().get(`/api/doctors/${doctorId}/slots`).query({ date }).expect(200)).body as {
      sessions: { startTime: string; endTime: string; capacity: number; booked: number; remaining: number }[];
      slots: { startTime: string; status: string }[];
      unavailableReason: string | null;
    };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await resetDatabase(db);
    ({ doctorId } = await insertFixtures(db));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailbox)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    patientToken = await login('patient1@test.local');
    otherPatientToken = await login('patient2@test.local');
    doctorToken = await login('doctor@test.local');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  describe('availability retrieval', () => {
    it('lists doctors with specialty, fee and weekly timings, and filters by search', async () => {
      const all = await http().get('/api/doctors').expect(200);
      expect(all.body).toHaveLength(1);
      expect(all.body[0]).toMatchObject({
        name: 'Dr. Test Doctor',
        consultationFee: 650,
        specialty: { name: 'ENT' },
      });
      expect(all.body[0].weeklyHours).toHaveLength(7);

      const bySpecialty = await http().get('/api/doctors').query({ search: 'ent' }).expect(200);
      expect(bySpecialty.body).toHaveLength(1);
      const noMatch = await http().get('/api/doctors').query({ search: 'cardio' }).expect(200);
      expect(noMatch.body).toHaveLength(0);
    });

    it('returns consultation-length slots and session capacity for a date', async () => {
      const day = await slotsFor(DAY_A);
      expect(day.slots).toEqual([
        { startTime: '10:00', endTime: '10:15', status: 'AVAILABLE' },
        { startTime: '10:15', endTime: '10:30', status: 'AVAILABLE' },
        { startTime: '10:30', endTime: '10:45', status: 'AVAILABLE' },
        { startTime: '10:45', endTime: '11:00', status: 'AVAILABLE' },
      ]);
      expect(day.sessions[0]).toMatchObject({ capacity: 2, booked: 0, remaining: 2 });
    });

    it('ignores unknown query parameters such as tracking tags, but still validates the real ones', async () => {
      const tracked = await http()
        .get('/api/doctors')
        .query({ utm_source: 'newsletter', utm_medium: 'email', fbclid: 'abc' })
        .expect(200);
      expect(tracked.body).toHaveLength(1);
      const filtered = await http().get('/api/doctors').query({ search: 'ent', utm_source: 'ads' }).expect(200);
      expect(filtered.body).toHaveLength(1);
      await http().get(`/api/doctors/${doctorId}/slots`).query({ date: DAY_A, utm_source: 'ads' }).expect(200);

      // Declared parameters keep their validation even when tracking tags are present.
      await http().get('/api/doctors').query({ specialtyId: 'not-a-uuid', utm_source: 'ads' }).expect(400);
      await http().get(`/api/doctors/${doctorId}/slots`).query({ date: '2026-02-30', utm_source: 'ads' }).expect(400);
      await http()
        .get('/api/doctor-portal/appointments')
        .query({ scope: 'everything', utm_source: 'ads' })
        .set('Authorization', `Bearer ${doctorToken}`)
        .expect(400);
    });

    it('rejects invalid dates and unknown doctors', async () => {
      await http().get(`/api/doctors/${doctorId}/slots`).query({ date: '2026-02-30' }).expect(400);
      await http().get('/api/doctors/00000000-0000-4000-8000-000000000000/slots').query({ date: DAY_A }).expect(404);
    });
  });

  describe('booking', () => {
    it('books a free slot, stores it in PostgreSQL and shows it on the doctor dashboard', async () => {
      const response = await book(patientToken, DAY_A, '10:15').expect(201);
      expect(response.body).toMatchObject({
        date: DAY_A,
        startTime: '10:15',
        endTime: '10:30',
        status: 'CONFIRMED',
        doctor: { name: 'Dr. Test Doctor', consultationFee: 650 },
      });

      const stored = await db.query(
        "SELECT appointment_date::text AS date, to_char(start_time, 'HH24:MI') AS start, status FROM appointments WHERE id = $1",
        [response.body.id],
      );
      expect(stored.rows[0]).toEqual({ date: DAY_A, start: '10:15', status: 'CONFIRMED' });

      const dashboard = await http()
        .get('/api/doctor-portal/appointments')
        .set('Authorization', `Bearer ${doctorToken}`)
        .expect(200);
      expect(dashboard.body).toContainEqual(
        expect.objectContaining({ id: response.body.id, date: DAY_A, startTime: '10:15', patient: expect.objectContaining({ name: 'Pat One' }) }),
      );

      const mine = await http().get('/api/appointments/mine').set('Authorization', `Bearer ${patientToken}`).expect(200);
      expect(mine.body.map((a: { id: string }) => a.id)).toContain(response.body.id);
    });

    it('rejects a slot that is already booked', async () => {
      const response = await book(otherPatientToken, DAY_A, '10:15').expect(409);
      expect(response.body.message).toMatch(/already been booked|just been booked/);
    });

    it('validates request bodies with Zod and explains each problem', async () => {
      const response = await http()
        .post('/api/appointments')
        .set('Authorization', `Bearer ${patientToken}`)
        .send({ doctorId: 'not-a-uuid', date: 'tomorrow', startTime: '9am', extra: true })
        .expect(400);
      const messages: string[] = response.body.message;
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining('doctorId'),
          'date: must be in YYYY-MM-DD format',
          'startTime: must be in HH:MM format',
        ]),
      );
      // Unknown fields are rejected too (strict schemas).
      expect(messages.some((message) => message.includes('extra'))).toBe(true);

      await http().post('/api/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
    });

    it('rejects times that are not one of the doctor’s slots', async () => {
      await book(patientToken, DAY_A, '10:05').expect(400);
      await book(patientToken, DAY_A, '12:00').expect(400);
    });
  });

  describe('capacity enforcement', () => {
    it('blocks booking once the session reaches its capacity and marks remaining slots FULL', async () => {
      await book(patientToken, DAY_B, '10:00').expect(201);
      await book(otherPatientToken, DAY_B, '10:30').expect(201);

      const full = await book(patientToken, DAY_B, '10:45').expect(409);
      expect(full.body.message).toMatch(/capacity/);

      const day = await slotsFor(DAY_B);
      expect(day.sessions[0]).toMatchObject({ capacity: 2, booked: 2, remaining: 0 });
      expect(day.slots.map((slot) => slot.status)).toEqual(['BOOKED', 'FULL', 'BOOKED', 'FULL']);
    });

    it('allows only `capacity` bookings when many requests arrive at the same time', async () => {
      const attempts = ['10:00', '10:15', '10:30', '10:45', '10:00', '10:15', '10:30', '10:45'];
      const results = await Promise.all(
        attempts.map((time, i) => book(i % 2 ? patientToken : otherPatientToken, DAY_C, time)),
      );
      const statuses = results.map((result) => result.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(2);
      expect(statuses.filter((status) => status !== 201).every((status) => status === 409)).toBe(true);

      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM appointments WHERE doctor_id = $1 AND appointment_date = $2 AND status IN ('PENDING','CONFIRMED')",
        [doctorId, DAY_C],
      );
      expect(rows[0].n).toBe(2);
    });
  });

  describe('doctor availability', () => {
    it('lets a doctor mark a date off, which removes its slots and blocks booking', async () => {
      await http()
        .put('/api/doctor-portal/availability/overrides')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ date: DAY_D, isAvailable: false, reason: 'Conference' })
        .expect(200);

      const day = await slotsFor(DAY_D);
      expect(day.slots).toEqual([]);
      expect(day.unavailableReason).toBe('Conference');
      await book(patientToken, DAY_D, '10:00').expect(400);
    });

    it('lets a doctor set different hours for a date, and patients see the new slots', async () => {
      await http()
        .put('/api/doctor-portal/availability/overrides')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ date: DAY_D, isAvailable: true, startTime: '14:00', endTime: '14:30', capacity: 1 })
        .expect(200);

      const day = await slotsFor(DAY_D);
      expect(day.slots.map((slot) => slot.startTime)).toEqual(['14:00', '14:15']);
      await book(patientToken, DAY_D, '14:15').expect(201);
      await book(otherPatientToken, DAY_D, '14:00').expect(409); // capacity 1 reached
    });

    it('replaces the weekly schedule and rejects overlapping sessions', async () => {
      await http()
        .put('/api/doctor-portal/availability/weekly')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ hours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00', capacity: 2 }, { dayOfWeek: 1, startTime: '09:30', endTime: '11:00', capacity: 2 }] })
        .expect(400);

      const saved = await http()
        .put('/api/doctor-portal/availability/weekly')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ hours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00', capacity: 2 }] })
        .expect(200);
      expect(saved.body.weekly).toEqual([{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00', capacity: 2 }]);
    });
  });

  describe('health', () => {
    it('reports app and database status without exposing configuration', async () => {
      const response = await http().get('/api/health').expect(200);
      expect(response.body).toMatchObject({ status: 'ok', service: 'outpatient-scheduler-api', database: 'up' });
      const text = JSON.stringify(response.body);
      expect(text).not.toMatch(/postgres|password|secret|jwt/i);
    });

    it('keeps serving GET / as Hello World!', async () => {
      const response = await http().get('/').expect(200);
      expect(response.text).toBe('Hello World!');
    });
  });

  describe('role access', () => {
    it('requires a signed-in user to book', async () => {
      await http().post('/api/appointments').send({ doctorId, date: DAY_A, startTime: '10:45' }).expect(401);
      await http().post('/api/appointments').set('Authorization', 'Bearer not-a-real-token').send({}).expect(401);
    });

    it('only lets patients book and only doctors use the doctor portal', async () => {
      await book(doctorToken, DAY_A, '10:45').expect(403);
      await http().get('/api/doctor-portal/appointments').set('Authorization', `Bearer ${patientToken}`).expect(403);
    });

    it('rejects a wrong password', async () => {
      await http().post('/api/auth/login').send({ email: 'patient1@test.local', password: 'wrong' }).expect(401);
    });
  });

  // Cancellation, rescheduling and doctor settings. These use dates further out (today + 8 and later) so they
  // never collide with the dates the tests above fill up.
  describe('appointment lifecycle and doctor settings', () => {
    type Appt = { id: string; status: string; cancelReason: string | null; rescheduledFromId: string | null; date: string; startTime: string };
    const day = (n: number) => addDays(today, n);
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const cancel = (token: string, id: string, body?: object) =>
      http().post(`/api/appointments/${id}/cancel`).set(auth(token)).send(body);
    const reschedule = (token: string, id: string, date: string, startTime: string) =>
      http().post(`/api/appointments/${id}/reschedule`).set(auth(token)).send({ date, startTime });
    const bookId = async (token: string, date: string, time: string) =>
      (await book(token, date, time).expect(201)).body.id as string;
    const rowOf = async (id: string) =>
      (await db.query('SELECT status, cancel_reason, cancelled_at, rescheduled_from_id FROM appointments WHERE id = $1', [id])).rows[0];
    const activeOn = async (date: string) =>
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM appointments WHERE doctor_id = $1 AND appointment_date = $2 AND status IN ('PENDING','CONFIRMED')",
            [doctorId, date],
          )
        ).rows[0].n,
      );
    const mine = async (token: string) => (await http().get('/api/appointments/mine').set(auth(token)).expect(200)).body as Appt[];
    // A confirmed appointment yesterday. Each call uses its own early-morning hour, outside the doctor's hours, so
    // it never collides with another one or changes what the 10:00 slots look like.
    let pastHour = 5;
    const insertPastAppointment = async (email: string) => {
      const { rows } = await db.query<{ patient_id: string; user_id: string }>(
        'SELECT p.id AS patient_id, u.id AS user_id FROM patients p JOIN users u ON u.id = p.user_id WHERE u.email = $1',
        [email],
      );
      const start = `${String(pastHour++).padStart(2, '0')}:00`;
      return (
        await db.query<{ id: string }>(
          `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status)
           VALUES ($1, $2, $3, $4, $5, $5::time + interval '15 minutes', 'CONFIRMED') RETURNING id`,
          [rows[0].patient_id, doctorId, rows[0].user_id, addDays(today, -1), start],
        )
      ).rows[0].id;
    };

    // Earlier tests leave the doctor with Monday-only hours: put back the fixture schedule (every day 10:00-11:00,
    // capacity 2, 15-minute slots, no date exceptions) so these tests do not depend on what ran before them.
    beforeAll(async () => {
      await db.query('DELETE FROM schedule_overrides WHERE doctor_id = $1', [doctorId]);
      await db.query('DELETE FROM availability WHERE doctor_id = $1', [doctorId]);
      for (let d = 0; d < 7; d++) {
        await db.query(
          "INSERT INTO availability (doctor_id, day_of_week, start_time, end_time, capacity) VALUES ($1, $2, '10:00', '11:00', 2)",
          [doctorId, d],
        );
      }
      await db.query('UPDATE doctors SET consultation_minutes = 15 WHERE id = $1', [doctorId]);
    });

    describe('cancellation', () => {
      it('cancels an appointment, frees its slot and session capacity, and keeps it as a cancelled record', async () => {
        const date = day(8);
        const first = await bookId(patientToken, date, '10:00');
        await bookId(otherPatientToken, date, '10:15');
        expect((await slotsFor(date)).slots.find((slot) => slot.startTime === '10:30')?.status).toBe('FULL');

        const cancelled = await cancel(patientToken, first, { reason: 'Changed plans' }).expect(200);
        expect(cancelled.body).toMatchObject({ id: first, status: 'CANCELLED', cancelReason: 'Changed plans' });
        expect((await rowOf(first)).cancelled_at).not.toBeNull();

        const after = await slotsFor(date);
        expect(after.sessions[0]).toMatchObject({ capacity: 2, booked: 1, remaining: 1 });
        expect(after.slots.map((slot) => slot.status)).toEqual(['AVAILABLE', 'BOOKED', 'AVAILABLE', 'AVAILABLE']);

        // The freed slot can be booked by someone else, and the session is full again.
        await bookId(otherPatientToken, date, '10:00');
        expect(await activeOn(date)).toBe(2);

        expect((await mine(patientToken)).find((a) => a.id === first)?.status).toBe('CANCELLED');
        const dashboard = (await http().get('/api/doctor-portal/appointments?scope=all').set(auth(doctorToken)).expect(200)).body as (Appt & {
          cancelReason: string | null;
        })[];
        expect(dashboard.find((a) => a.id === first)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Changed plans' });
      });

      it('cancels without a reason and records a default one', async () => {
        const id = await bookId(patientToken, day(9), '10:00');
        const response = await cancel(patientToken, id).expect(200);
        expect(response.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Cancelled by patient' });
      });

      it('rejects invalid cancellations without changing anything', async () => {
        const id = await bookId(patientToken, day(10), '10:00');
        await cancel(otherPatientToken, id).expect(404); // someone else's appointment looks like a missing one
        await http().post(`/api/appointments/${id}/cancel`).expect(401);
        await cancel(doctorToken, id).expect(403);
        await cancel(patientToken, 'not-a-uuid').expect(400);
        await cancel(patientToken, '00000000-0000-4000-8000-000000000000').expect(404);
        await cancel(patientToken, id, { reason: 'x', extra: true }).expect(400);
        await cancel(patientToken, id, { reason: 'x'.repeat(201) }).expect(400);
        expect((await rowOf(id)).status).toBe('CONFIRMED');

        await cancel(patientToken, id).expect(200);
        const again = await cancel(patientToken, id).expect(409);
        expect(again.body.message).toMatch(/already cancelled/);
      });

      it('does not allow cancelling an appointment that has already passed', async () => {
        const id = await insertPastAppointment('patient1@test.local');
        const response = await cancel(patientToken, id).expect(409);
        expect(response.body.message).toMatch(/already started or passed/);
        expect((await rowOf(id)).status).toBe('CONFIRMED');
      });
    });

    describe('rescheduling', () => {
      it('moves an appointment to a free slot and releases the old one', async () => {
        const from = day(11);
        const to = day(12);
        const original = await bookId(patientToken, from, '10:00');

        const moved = await reschedule(patientToken, original, to, '10:30').expect(201);
        expect(moved.body).toMatchObject({ date: to, startTime: '10:30', endTime: '10:45', status: 'CONFIRMED', rescheduledFromId: original });
        expect(moved.body.id).not.toBe(original);

        expect(await rowOf(original)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Rescheduled by patient' });
        expect((await rowOf(original)).cancelled_at).not.toBeNull();
        expect((await rowOf(moved.body.id)).rescheduled_from_id).toBe(original);

        const oldDay = await slotsFor(from);
        expect(oldDay.sessions[0]).toMatchObject({ booked: 0, remaining: 2 });
        expect(oldDay.slots[0].status).toBe('AVAILABLE');
        expect((await slotsFor(to)).slots.find((slot) => slot.startTime === '10:30')?.status).toBe('BOOKED');

        const list = await mine(patientToken);
        expect(list.find((a) => a.id === original)?.status).toBe('CANCELLED');
        expect(list.find((a) => a.id === moved.body.id)?.status).toBe('CONFIRMED');
        const dashboard = (await http().get('/api/doctor-portal/appointments?scope=all').set(auth(doctorToken)).expect(200)).body as Appt[];
        expect(dashboard.find((a) => a.id === moved.body.id)?.status).toBe('CONFIRMED');
      });

      it('can move within a session that is full only because of the appointment itself', async () => {
        const date = day(13);
        const mine1 = await bookId(patientToken, date, '10:00');
        await bookId(otherPatientToken, date, '10:15');
        expect((await slotsFor(date)).sessions[0]).toMatchObject({ booked: 2, remaining: 0 });

        const moved = await reschedule(patientToken, mine1, date, '10:30').expect(201);
        expect(moved.body).toMatchObject({ date, startTime: '10:30', status: 'CONFIRMED' });
        expect(await activeOn(date)).toBe(2);
        expect((await rowOf(mine1)).status).toBe('CANCELLED');
      });

      it('rejects a booked slot or a full session and leaves the original appointment untouched', async () => {
        const fullDay = day(14);
        await bookId(patientToken, fullDay, '10:00');
        await bookId(otherPatientToken, fullDay, '10:15'); // capacity 2 reached
        const origin = day(15);
        const original = await bookId(patientToken, origin, '10:00');

        const taken = await reschedule(patientToken, original, fullDay, '10:15').expect(409);
        expect(taken.body.message).toMatch(/just been booked/);
        const full = await reschedule(patientToken, original, fullDay, '10:30').expect(409);
        expect(full.body.message).toMatch(/capacity/);

        expect((await rowOf(original)).status).toBe('CONFIRMED');
        expect((await slotsFor(origin)).slots[0].status).toBe('BOOKED');
        expect(await activeOn(fullDay)).toBe(2);
      });

      it('validates the request and the new time', async () => {
        const date = day(16);
        const original = await bookId(patientToken, date, '10:00');
        const target = day(17);

        const same = await reschedule(patientToken, original, date, '10:00').expect(400);
        expect(same.body.message).toMatch(/already have this appointment/);
        await reschedule(patientToken, original, target, '10:20').expect(400); // not a slot
        const past = await reschedule(patientToken, original, addDays(today, -1), '10:00').expect(400);
        expect(past.body.message).toMatch(/already passed/);
        await reschedule(patientToken, original, day(60), '10:00').expect(400); // beyond the booking window
        await http().post(`/api/appointments/${original}/reschedule`).set(auth(patientToken)).send({ date: target }).expect(400);
        await http().post(`/api/appointments/${original}/reschedule`).set(auth(patientToken)).send({ date: target, startTime: '10:00', x: 1 }).expect(400);
        await reschedule(patientToken, 'not-a-uuid', target, '10:00').expect(400);

        expect((await rowOf(original)).status).toBe('CONFIRMED'); // every failure rolled back
        expect(await activeOn(target)).toBe(0);
      });

      it('only lets the owner reschedule an active, upcoming appointment', async () => {
        const original = await bookId(patientToken, day(16), '10:15');
        const target = day(17);
        await reschedule(otherPatientToken, original, target, '10:00').expect(404);
        await http().post(`/api/appointments/${original}/reschedule`).send({ date: target, startTime: '10:00' }).expect(401);
        await reschedule(doctorToken, original, target, '10:00').expect(403);
        await reschedule(patientToken, '00000000-0000-4000-8000-000000000000', target, '10:00').expect(404);

        const past = await insertPastAppointment('patient1@test.local');
        const pastResponse = await reschedule(patientToken, past, target, '10:00').expect(409);
        expect(pastResponse.body.message).toMatch(/already started or passed/);

        await cancel(patientToken, original).expect(200);
        const cancelled = await reschedule(patientToken, original, target, '10:00').expect(409);
        expect(cancelled.body.message).toMatch(/already cancelled/);
        expect(await activeOn(target)).toBe(0);
      });

      it('lets only one of two patients win the last free place in a session', async () => {
        const target = day(18);
        await bookId(otherPatientToken, target, '10:00'); // 1 of 2 places taken
        const a1 = await bookId(patientToken, day(19), '10:00');
        const a2 = await bookId(otherPatientToken, day(19), '10:15');

        const results = await Promise.all([
          reschedule(patientToken, a1, target, '10:15'),
          reschedule(otherPatientToken, a2, target, '10:30'),
        ]);
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
        expect(await activeOn(target)).toBe(2);
        const statuses = [(await rowOf(a1)).status, (await rowOf(a2)).status].sort((a, b) => a.localeCompare(b));
        expect(statuses).toEqual(['CANCELLED', 'CONFIRMED']); // the loser keeps its original appointment
      });

      it('allows only `capacity` reschedules into a session when many arrive at once', async () => {
        const target = day(25);
        const originals = [];
        for (let i = 0; i < 5; i++) originals.push(await bookId(patientToken, day(20 + i), '10:00'));
        const times = ['10:00', '10:15', '10:30', '10:45', '10:00'];

        const results = await Promise.all(originals.map((id, i) => reschedule(patientToken, id, target, times[i])));
        const statuses = results.map((r) => r.status);
        expect(statuses.filter((status) => status === 201)).toHaveLength(2);
        expect(statuses.filter((status) => status !== 201).every((status) => status === 409)).toBe(true);
        expect(await activeOn(target)).toBe(2);

        const rows = [];
        for (const id of originals) rows.push(await rowOf(id)); // one query at a time: the test connection is shared
        expect(rows.filter((row) => row.status === 'CONFIRMED')).toHaveLength(3); // losers keep their original
      });

      it('never leaves two active appointments when a cancel races a reschedule', async () => {
        const origin = day(26);
        const target = day(27);
        const id = await bookId(patientToken, origin, '10:00');

        const results = await Promise.all([cancel(patientToken, id), reschedule(patientToken, id, target, '10:00')]);
        expect(results.filter((r) => r.status < 300)).toHaveLength(1);
        expect(results.filter((r) => r.status >= 300).every((r) => r.status === 409)).toBe(true);
        expect((await activeOn(origin)) + (await activeOn(target))).toBeLessThanOrEqual(1);
      });
    });

    describe('doctor sessions and slot length', () => {
      const settings = (token: string, body: unknown) => http().put('/api/doctor-portal/settings').set(auth(token)).send(body as object);
      const minutesInDb = async () =>
        (await db.query('SELECT consultation_minutes AS m FROM doctors WHERE id = $1', [doctorId])).rows[0].m as number;

      // Each test starts from "no upcoming appointments", which slot-length changes require.
      beforeEach(async () => {
        await db.query(
          "UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'test cleanup', cancelled_at = now(), cancelled_by_user_id = booked_by_user_id WHERE status IN ('PENDING','CONFIRMED')",
        );
      });

      it('persists weekly session hours and capacity and reflects them in patient availability', async () => {
        const date = day(9);
        const dow = dayOfWeek(date);
        const original = Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startTime: '10:00', endTime: '11:00', capacity: 2 }));
        const custom = [
          ...original.filter((hours) => hours.dayOfWeek !== dow),
          { dayOfWeek: dow, startTime: '09:00', endTime: '10:00', capacity: 1 },
          { dayOfWeek: dow, startTime: '14:00', endTime: '15:00', capacity: 3 },
        ];
        const put = (hours: unknown[]) => http().put('/api/doctor-portal/availability/weekly').set(auth(doctorToken)).send({ hours });
        try {
          await put(custom).expect(200);
          const saved = (await http().get('/api/doctor-portal/availability').set(auth(doctorToken)).expect(200)).body as {
            weekly: { dayOfWeek: number; startTime: string; endTime: string; capacity: number }[];
          };
          expect(saved.weekly.filter((hours) => hours.dayOfWeek === dow)).toEqual([
            { dayOfWeek: dow, startTime: '09:00', endTime: '10:00', capacity: 1 },
            { dayOfWeek: dow, startTime: '14:00', endTime: '15:00', capacity: 3 },
          ]);

          const schedule = await slotsFor(date);
          expect(schedule.sessions.map((s) => [s.startTime, s.endTime, s.capacity])).toEqual([
            ['09:00', '10:00', 1],
            ['14:00', '15:00', 3],
          ]);
          expect(schedule.slots).toHaveLength(8);

          await book(patientToken, date, '09:00').expect(201); // fills the capacity-1 morning session
          const full = await book(otherPatientToken, date, '09:15').expect(409);
          expect(full.body.message).toMatch(/capacity/);
          await book(otherPatientToken, date, '14:00').expect(201); // the afternoon session is separate
        } finally {
          await put(original).expect(200);
        }
      });

      it('validates the settings request and who may send it', async () => {
        await settings(doctorToken, { consultationMinutes: 4 }).expect(400);
        await settings(doctorToken, { consultationMinutes: 121 }).expect(400);
        await settings(doctorToken, { consultationMinutes: '15' }).expect(400);
        await settings(doctorToken, { consultationMinutes: 12.5 }).expect(400);
        await settings(doctorToken, {}).expect(400);
        await settings(doctorToken, { consultationMinutes: 15, extra: true }).expect(400);
        await settings(patientToken, { consultationMinutes: 20 }).expect(403);
        await http().put('/api/doctor-portal/settings').send({ consultationMinutes: 20 }).expect(401);
        expect(await minutesInDb()).toBe(15);
      });

      it('changes the slot length, persists it and regenerates the slots', async () => {
        const date = day(10);
        expect((await slotsFor(date)).slots).toHaveLength(4);

        const response = await settings(doctorToken, { consultationMinutes: 30 }).expect(200);
        expect(response.body.consultationMinutes).toBe(30);
        expect(await minutesInDb()).toBe(30);
        expect((await slotsFor(date)).slots.map((slot) => slot.startTime)).toEqual(['10:00', '10:30']);

        const booking = await book(patientToken, date, '10:30').expect(201);
        expect(booking.body).toMatchObject({ startTime: '10:30', endTime: '11:00' });

        // With a booking in place the length can no longer change, because it would stop lining up with the slots.
        const refused = await settings(doctorToken, { consultationMinutes: 15 }).expect(409);
        expect(refused.body.message).toMatch(/upcoming appointment/);
        expect(await minutesInDb()).toBe(30);

        await cancel(patientToken, booking.body.id).expect(200);
        await settings(doctorToken, { consultationMinutes: 15 }).expect(200);
        expect((await slotsFor(date)).slots).toHaveLength(4);
      });

      it('refuses a slot length that does not fit a working session, and treats an unchanged length as a no-op', async () => {
        const tooLong = await settings(doctorToken, { consultationMinutes: 90 }).expect(400);
        expect(tooLong.body.message).toMatch(/at least 90 minutes/);
        expect(await minutesInDb()).toBe(15);

        await settings(doctorToken, { consultationMinutes: 15 }).expect(200);
        expect(await minutesInDb()).toBe(15);
      });
    });
  });

  describe('sign-up, email verification and onboarding', () => {
    const NEW_PASSWORD = 'Sup3r-secret!';
    const post = (path: string, body: object, token?: string) => {
      const req = http().post(`/api/auth${path}`);
      if (token) req.set('Authorization', `Bearer ${token}`);
      return req.send(body);
    };
    const codeSentTo = (email: string) => {
      const mail = [...sentEmails].reverse().find((m) => m.to === email);
      const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
      if (!code) throw new Error(`No verification email was sent to ${email}`);
      return code;
    };
    const wrongCode = (real: string) => (real === '000000' ? '111111' : '000000');
    const pendingRow = async (email: string) =>
      (await db.query('SELECT * FROM email_verifications WHERE email = $1', [email])).rows[0];
    // Moves the last email into the past so the 30-second resend limit does not slow the tests down.
    const allowResend = (email: string) =>
      db.query("UPDATE email_verifications SET last_sent_at = now() - interval '1 minute' WHERE email = $1", [email]);
    const registerAndVerify = async (email: string) => {
      await post('/register', { email, password: NEW_PASSWORD }).expect(202);
      return (await post('/verify-email', { email, code: codeSentTo(email) }).expect(200)).body.signupToken as string;
    };
    const specialtyId = async () => ((await http().get('/api/specialties').expect(200)).body as { id: string }[])[0].id;
    const clinicId = async () => ((await http().get('/api/clinics').expect(200)).body as { id: string }[])[0].id;

    it('registers, emails a 6-digit code and stores only hashes, with no user created yet', async () => {
      const response = await post('/register', { email: 'New.Person@Test.Local', password: NEW_PASSWORD }).expect(202);
      expect(response.body).toMatchObject({ email: 'new.person@test.local', resendAvailableInSeconds: 30 });

      const mail = sentEmails.find((m) => m.to === 'new.person@test.local');
      expect(mail?.subject).toMatch(/verification code/i);
      const code = codeSentTo('new.person@test.local');
      expect(code).toMatch(/^\d{6}$/);

      const row = await pendingRow('new.person@test.local');
      expect(row.password_hash).toMatch(/^scrypt\$/);
      expect(row.password_hash).not.toContain(NEW_PASSWORD);
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.code_hash).not.toContain(code);
      expect(row.verified_at).toBeNull();
      expect((await db.query("SELECT count(*)::int AS n FROM users WHERE lower(email) = 'new.person@test.local'")).rows[0].n).toBe(0);
    });

    it('validates the sign-up requests', async () => {
      const bad = await post('/register', { email: 'not-an-email', password: NEW_PASSWORD }).expect(400);
      expect(JSON.stringify(bad.body.message)).toMatch(/email/);
      const short = await post('/register', { email: 'short@test.local', password: '1234567' }).expect(400);
      expect(JSON.stringify(short.body.message)).toMatch(/password: must be at least 8 characters/);
      await post('/register', { email: 'x@test.local', password: NEW_PASSWORD, role: 'DOCTOR' }).expect(400);
      await post('/verify-email', { email: 'x@test.local', code: 'abc123' }).expect(400);
      await post('/verify-email', { email: 'x@test.local', code: '12345' }).expect(400);
      await post('/resend-code', {}).expect(400);
      expect(await pendingRow('short@test.local')).toBeUndefined();
    });

    it('refuses an email that already has an account, whatever its case', async () => {
      const response = await post('/register', { email: 'patient1@test.local', password: NEW_PASSWORD }).expect(409);
      expect(response.body.message).toMatch(/already exists/);
      await post('/register', { email: 'PATIENT1@TEST.LOCAL', password: NEW_PASSWORD }).expect(409);
    });

    it('limits wrong guesses, then needs a fresh code that replaces the old one', async () => {
      const email = 'guesser@test.local';
      await post('/register', { email, password: NEW_PASSWORD }).expect(202);
      const real = codeSentTo(email);

      const first = await post('/verify-email', { email, code: wrongCode(real) }).expect(400);
      expect(first.body.message).toMatch(/4 attempts left/);
      for (let i = 0; i < 3; i++) await post('/verify-email', { email, code: wrongCode(real) }).expect(400);
      const last = await post('/verify-email', { email, code: wrongCode(real) }).expect(400);
      expect(last.body.message).toMatch(/no attempts left/);

      // Locked: even the right code is refused until a new one is requested.
      await post('/verify-email', { email, code: real }).expect(429);

      await allowResend(email);
      await post('/resend-code', { email }).expect(202);
      const fresh = codeSentTo(email);
      if (fresh !== real) await post('/verify-email', { email, code: real }).expect(400); // the old code is dead
      await post('/verify-email', { email, code: fresh }).expect(200);
    });

    it('rejects an expired code', async () => {
      const email = 'slowpoke@test.local';
      await post('/register', { email, password: NEW_PASSWORD }).expect(202);
      await db.query("UPDATE email_verifications SET expires_at = now() - interval '1 minute' WHERE email = $1", [email]);
      const response = await post('/verify-email', { email, code: codeSentTo(email) }).expect(400);
      expect(response.body.message).toMatch(/expired/);
    });

    it('rate-limits resending, and does not reveal whether an address has a pending sign-up', async () => {
      const email = 'eager@test.local';
      await post('/register', { email, password: NEW_PASSWORD }).expect(202);
      const sentBefore = sentEmails.length;

      const tooSoon = await post('/resend-code', { email }).expect(429);
      expect(tooSoon.body.retryAfterSeconds).toBeGreaterThan(0);
      await post('/register', { email, password: NEW_PASSWORD }).expect(429);
      expect(sentEmails.length).toBe(sentBefore);

      await post('/resend-code', { email: 'nobody-here@test.local' }).expect(202);
      expect(sentEmails.length).toBe(sentBefore); // same answer, but nothing was sent
    });

    it('reports a failed email send without exposing provider details, and recovers', async () => {
      const email = 'unlucky@test.local';
      failNextEmail = true;
      const response = await post('/register', { email, password: NEW_PASSWORD }).expect(503);
      expect(response.body.message).toMatch(/could not send the verification email/i);
      expect(JSON.stringify(response.body)).not.toMatch(/outage|provider/i);

      await allowResend(email);
      await post('/register', { email, password: NEW_PASSWORD }).expect(202);
      expect(codeSentTo(email)).toMatch(/^\d{6}$/);
    });

    it('gives a sign-up token that can finish the profile but can never act as a session', async () => {
      const token = await registerAndVerify('tokenholder@test.local');
      await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
      await http().get('/api/appointments/mine').set('Authorization', `Bearer ${token}`).expect(401);
      await http().get('/api/doctor-portal/availability').set('Authorization', `Bearer ${token}`).expect(401);
      // And the other way round: a normal session is not a sign-up token.
      await post('/complete-profile', { role: 'PATIENT', firstName: 'A', lastName: 'B' }, patientToken).expect(401);
      await post('/complete-profile', { role: 'PATIENT', firstName: 'A', lastName: 'B' }).expect(401);
      await post('/complete-profile', { role: 'PATIENT', firstName: 'A', lastName: 'B' }, 'garbage').expect(401);
    });

    it('creates a patient account that can sign in and book, and uses the sign-up token only once', async () => {
      const email = 'asha@test.local';
      const token = await registerAndVerify(email);
      const created = await post(
        '/complete-profile',
        { role: 'PATIENT', firstName: ' Asha ', lastName: 'Verma', phone: '+91 98765 43210', dateOfBirth: '1990-05-17', gender: 'Female' },
        token,
      ).expect(201);
      expect(created.body.user).toMatchObject({ name: 'Asha Verma', email, role: 'PATIENT' });

      const { rows } = await db.query(
        `SELECT u.password_hash, p.phone, p.date_of_birth::text AS dob, p.gender
           FROM users u JOIN patients p ON p.user_id = u.id WHERE u.email = $1`,
        [email],
      );
      expect(rows[0]).toMatchObject({ phone: '+91 98765 43210', dob: '1990-05-17', gender: 'Female' });
      expect(rows[0].password_hash).toMatch(/^scrypt\$/);
      expect(await pendingRow(email)).toBeUndefined();

      const session = created.body.accessToken as string;
      await http().get('/api/auth/me').set('Authorization', `Bearer ${session}`).expect(200);
      await http().get('/api/appointments/mine').set('Authorization', `Bearer ${session}`).expect(200);
      await book(session, addDays(today, 20), '10:00').expect(201); // a brand-new patient can book straight away
      await post('/login', { email, password: NEW_PASSWORD }).expect(200);

      await post('/complete-profile', { role: 'PATIENT', firstName: 'Asha', lastName: 'Again' }, token).expect(403);
    });

    it('validates the profile for each role', async () => {
      const token = await registerAndVerify('picky@test.local');
      const base = { firstName: 'Pat', lastName: 'Ient' };
      const spec = await specialtyId();
      const clinic = await clinicId();
      const doctor = { role: 'DOCTOR', ...base, specialtyId: spec, clinicId: clinic, consultationFee: 500 };

      await post('/complete-profile', { role: 'PATIENT', ...base, specialtyId: spec }, token).expect(400); // doctor field on a patient
      await post('/complete-profile', { role: 'PATIENT', ...base, phone: 'call me' }, token).expect(400);
      await post('/complete-profile', { role: 'PATIENT', ...base, dateOfBirth: '2999-01-01' }, token).expect(400);
      await post('/complete-profile', { role: 'PATIENT', ...base, dateOfBirth: '1850-01-01' }, token).expect(400);
      await post('/complete-profile', { role: 'PATIENT', ...base, gender: 'x' }, token).expect(400);
      await post('/complete-profile', { role: 'PATIENT', firstName: '', lastName: 'Ient' }, token).expect(400);
      await post('/complete-profile', { role: 'PATIENT', firstName: 'x'.repeat(51), lastName: 'Ient' }, token).expect(400);
      await post('/complete-profile', { role: 'ADMIN', ...base }, token).expect(400); // no self-service admins
      await post('/complete-profile', { ...base }, token).expect(400);

      await post('/complete-profile', { role: 'DOCTOR', ...base, clinicId: clinic, consultationFee: 500 }, token).expect(400); // no specialty
      await post('/complete-profile', { ...doctor, consultationFee: -1 }, token).expect(400);
      await post('/complete-profile', { ...doctor, consultationFee: 99.5 }, token).expect(400);
      await post('/complete-profile', { ...doctor, specialtyId: '00000000-0000-4000-8000-000000000000' }, token).expect(400);
      await post('/complete-profile', { ...doctor, clinicId: '00000000-0000-4000-8000-000000000000' }, token).expect(400);

      expect((await db.query("SELECT count(*)::int AS n FROM users WHERE email = 'picky@test.local'")).rows[0].n).toBe(0);
      expect((await pendingRow('picky@test.local')).verified_at).not.toBeNull(); // still able to finish correctly
    });

    it('creates a doctor who is listed, can set sessions, and then gets bookable slots', async () => {
      const email = 'meera@test.local';
      const token = await registerAndVerify(email);
      const created = await post(
        '/complete-profile',
        { role: 'DOCTOR', firstName: 'Meera', lastName: 'Shah', specialtyId: await specialtyId(), clinicId: await clinicId(), consultationFee: 750, bio: 'MBBS, MD.' },
        token,
      ).expect(201);
      expect(created.body.user).toMatchObject({ name: 'Dr. Meera Shah', role: 'DOCTOR' });
      const session = created.body.accessToken as string;

      const listed = ((await http().get('/api/doctors').query({ search: 'Meera' }).expect(200)).body as {
        id: string;
        name: string;
        consultationFee: number;
        consultationMinutes: number;
        weeklyHours: unknown[];
      }[])[0];
      expect(listed).toMatchObject({ name: 'Dr. Meera Shah', consultationFee: 750, consultationMinutes: 15, weeklyHours: [] });

      const mineAvailability = await http().get('/api/doctor-portal/availability').set('Authorization', `Bearer ${session}`).expect(200);
      expect(mineAvailability.body).toMatchObject({ consultationMinutes: 15, weekly: [] });

      const hours = Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startTime: '09:00', endTime: '10:00', capacity: 2 }));
      await http().put('/api/doctor-portal/availability/weekly').set('Authorization', `Bearer ${session}`).send({ hours }).expect(200);
      const slots = await http().get(`/api/doctors/${listed.id}/slots`).query({ date: DAY_A }).expect(200);
      expect(slots.body.slots).toHaveLength(4);
      await http()
        .post('/api/appointments')
        .set('Authorization', `Bearer ${patientToken}`)
        .send({ doctorId: listed.id, date: DAY_A, startTime: '09:00' })
        .expect(201);
    });

    it('lets someone who left half-way pick the sign-up up again by signing in', async () => {
      const email = 'halfway@test.local';
      await post('/register', { email, password: NEW_PASSWORD }).expect(202);

      const unverified = await post('/login', { email, password: NEW_PASSWORD }).expect(403);
      expect(unverified.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
      await post('/login', { email, password: 'Wrong-password1' }).expect(401);

      await post('/verify-email', { email, code: codeSentTo(email) }).expect(200);
      const resumed = await post('/login', { email, password: NEW_PASSWORD }).expect(200);
      expect(resumed.body).toMatchObject({ onboardingRequired: true, email });
      expect(resumed.body.accessToken).toBeUndefined();

      const finished = await post('/complete-profile', { role: 'PATIENT', firstName: 'Half', lastName: 'Way' }, resumed.body.signupToken).expect(201);
      expect(finished.body.user.role).toBe('PATIENT');
    });

    it('creates the account only once when the profile is submitted twice at the same time', async () => {
      const email = 'doubleclick@test.local';
      const token = await registerAndVerify(email);
      const results = await Promise.all([
        post('/complete-profile', { role: 'PATIENT', firstName: 'Double', lastName: 'Click' }, token),
        post('/complete-profile', { role: 'PATIENT', firstName: 'Double', lastName: 'Click' }, token),
      ]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 201).every((r) => [403, 409].includes(r.status))).toBe(true);
      expect((await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email])).rows[0].n).toBe(1);
    });

    it('serves the clinic and specialty lists the doctor form needs, without signing in', async () => {
      const clinics = (await http().get('/api/clinics').expect(200)).body as { id: string; name: string; address: string }[];
      expect(clinics).toContainEqual(expect.objectContaining({ name: 'Test Clinic', address: '1 Test St' }));
      expect(((await http().get('/api/specialties').expect(200)).body as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe('next available slot and doctor profile', () => {
    type Next = { date: string; startTime: string; endTime: string } | null;
    type Profile = { name: string; email: string; specialtyId: string; clinicId: string; consultationFee: number; bio: string | null };
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const profileUrl = '/api/doctor-portal/profile';
    const listed = async (search?: string) =>
      (await http().get('/api/doctors').query(search ? { search } : {}).expect(200)).body as {
        id: string;
        name: string;
        bio: string | null;
        consultationFee: number;
        specialty: { id: string };
        clinic: { name: string };
        nextAvailable: Next;
      }[];
    const putProfile = (token: string, body: unknown) => http().put(profileUrl).set(auth(token)).send(body as object);

    let original: Profile;
    let otherClinicId: string;
    let otherSpecialtyId: string;

    beforeAll(async () => {
      original = (await http().get(profileUrl).set(auth(doctorToken)).expect(200)).body as Profile;
      otherClinicId = (await db.query<{ id: string }>("INSERT INTO clinics (name, address) VALUES ('Second Clinic', '2 Test Ave') RETURNING id")).rows[0].id;
      otherSpecialtyId = (await db.query<{ id: string }>("INSERT INTO specialties (name) VALUES ('Cardiology') RETURNING id")).rows[0].id;
    });

    afterAll(async () => {
      // Put the fixture doctor back exactly as it was, then remove what these tests added.
      await db.query('UPDATE users SET name = $1 WHERE email = $2', [original.name, original.email]);
      await db.query('UPDATE doctors SET specialty_id = $1, clinic_id = $2, consultation_fee = $3, bio = $4 WHERE id = $5', [
        original.specialtyId,
        original.clinicId,
        original.consultationFee,
        original.bio,
        doctorId,
      ]);
      await db.query('DELETE FROM clinics WHERE id = $1', [otherClinicId]);
      await db.query('DELETE FROM specialties WHERE id = $1', [otherSpecialtyId]);
    });

    it('lists the first bookable slot for every doctor, matching what the slots endpoint offers', async () => {
      const doctors = await listed();
      expect(doctors.length).toBeGreaterThan(1);
      for (const doctor of doctors) {
        let expected: Next = null;
        for (let offset = 0; offset < 14 && !expected; offset++) {
          const date = addDays(today, offset);
          const schedule = (await http().get(`/api/doctors/${doctor.id}/slots`).query({ date }).expect(200)).body as {
            slots: { startTime: string; endTime: string; status: string }[];
          };
          const free = schedule.slots.find((slot) => slot.status === 'AVAILABLE');
          if (free) expected = { date, startTime: free.startTime, endTime: free.endTime };
        }
        expect({ doctor: doctor.name, next: doctor.nextAvailable }).toEqual({ doctor: doctor.name, next: expected });
      }
      expect(doctors.some((doctor) => doctor.nextAvailable === null)).toBe(false);
    });

    it('is null for a doctor with no sessions, and also served on the single-doctor endpoint', async () => {
      const newcomer = await registerAndVerifyDoctor('nosessions@test.local');
      expect(newcomer.nextAvailable).toBeNull();
      const single = (await http().get(`/api/doctors/${newcomer.id}`).expect(200)).body as { nextAvailable: Next };
      expect(single.nextAvailable).toBeNull();
      const fixture = (await http().get(`/api/doctors/${doctorId}`).expect(200)).body as { nextAvailable: Next };
      expect(fixture.nextAvailable?.date).toBeDefined();
    });

    it('moves to a later day when the next one is taken off, and comes back when the day off is removed', async () => {
      const before = (await listed('Test Doctor'))[0].nextAvailable;
      expect(before).not.toBeNull();
      const date = before!.date;

      await http()
        .put('/api/doctor-portal/availability/overrides')
        .set(auth(doctorToken))
        .send({ date, isAvailable: false, reason: 'Conference' })
        .expect(200);
      const during = (await listed('Test Doctor'))[0].nextAvailable;
      expect(during!.date > date).toBe(true);

      await http().delete(`/api/doctor-portal/availability/overrides/${date}`).set(auth(doctorToken)).expect(200);
      expect((await listed('Test Doctor'))[0].nextAvailable).toEqual(before);
    });

    it('shows the doctor their own profile', async () => {
      const profile = (await http().get(profileUrl).set(auth(doctorToken)).expect(200)).body as Profile & { consultationMinutes: number };
      expect(profile).toMatchObject({ name: 'Dr. Test Doctor', email: 'doctor@test.local', consultationFee: 650, consultationMinutes: 15 });
      await http().get(profileUrl).set(auth(patientToken)).expect(403);
      await http().get(profileUrl).expect(401);
    });

    it('updates name, specialty, fee and bio, adds the Dr. title, and shows it in the directory', async () => {
      const response = await putProfile(doctorToken, {
        name: 'Test Doctor Renamed',
        specialtyId: otherSpecialtyId,
        clinicId: original.clinicId,
        consultationFee: 900,
        bio: '  MBBS, MD (Cardiology).  ',
      }).expect(200);
      expect(response.body).toMatchObject({ name: 'Dr. Test Doctor Renamed', consultationFee: 900, bio: 'MBBS, MD (Cardiology).', specialtyId: otherSpecialtyId });

      const card = (await listed('Renamed'))[0];
      expect(card).toMatchObject({ name: 'Dr. Test Doctor Renamed', consultationFee: 900, bio: 'MBBS, MD (Cardiology).' });
      expect(card.specialty.id).toBe(otherSpecialtyId);

      const cleared = await putProfile(doctorToken, { name: 'Dr. Test Doctor', specialtyId: original.specialtyId, clinicId: original.clinicId, consultationFee: 650, bio: null }).expect(200);
      expect(cleared.body).toMatchObject({ name: 'Dr. Test Doctor', bio: null }); // no doubled "Dr. Dr."
    });

    it('refuses to move clinic while upcoming appointments exist, then allows it once there are none', async () => {
      await db.query(
        "UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'test cleanup', cancelled_at = now(), cancelled_by_user_id = booked_by_user_id WHERE status IN ('PENDING','CONFIRMED')",
      );
      await book(patientToken, addDays(today, 25), '10:00').expect(201);
      const move = { name: 'Dr. Test Doctor', specialtyId: original.specialtyId, clinicId: otherClinicId, consultationFee: 650, bio: null };

      const refused = await putProfile(doctorToken, move).expect(409);
      expect(refused.body.message).toMatch(/upcoming appointment/);
      expect((await db.query('SELECT clinic_id FROM doctors WHERE id = $1', [doctorId])).rows[0].clinic_id).toBe(original.clinicId);

      await db.query("UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'test cleanup', cancelled_at = now(), cancelled_by_user_id = booked_by_user_id WHERE status IN ('PENDING','CONFIRMED')");
      await putProfile(doctorToken, move).expect(200);
      expect((await listed('Test Doctor'))[0].clinic.name).toBe('Second Clinic');
      await putProfile(doctorToken, { ...move, clinicId: original.clinicId }).expect(200);
    });

    it('validates the profile request and who may send it', async () => {
      const valid = { name: 'Dr. Test Doctor', specialtyId: original.specialtyId, clinicId: original.clinicId, consultationFee: 650, bio: null };
      await putProfile(doctorToken, { ...valid, name: 'D' }).expect(400);
      await putProfile(doctorToken, { ...valid, name: 'x'.repeat(101) }).expect(400);
      await putProfile(doctorToken, { ...valid, consultationFee: -5 }).expect(400);
      await putProfile(doctorToken, { ...valid, consultationFee: 12.5 }).expect(400);
      await putProfile(doctorToken, { ...valid, consultationFee: 100001 }).expect(400);
      await putProfile(doctorToken, { ...valid, bio: 'x'.repeat(1001) }).expect(400);
      await putProfile(doctorToken, { ...valid, extra: true }).expect(400);
      const { bio: _omitted, ...withoutBio } = valid;
      await putProfile(doctorToken, withoutBio).expect(400);
      const unknownSpecialty = await putProfile(doctorToken, { ...valid, specialtyId: '00000000-0000-4000-8000-000000000000' }).expect(400);
      expect(JSON.stringify(unknownSpecialty.body.message)).toMatch(/specialtyId/);
      await putProfile(doctorToken, { ...valid, clinicId: '00000000-0000-4000-8000-000000000000' }).expect(400);
      await putProfile(patientToken, valid).expect(403);
      await http().put(profileUrl).send(valid).expect(401);
      expect((await http().get(profileUrl).set(auth(doctorToken)).expect(200)).body.name).toBe('Dr. Test Doctor');
    });

    async function registerAndVerifyDoctor(email: string) {
      await http().post('/api/auth/register').send({ email, password: 'Sup3r-secret!' }).expect(202);
      const code = [...sentEmails].reverse().find((m) => m.to === email)!.text.match(/\b(\d{6})\b/)![1];
      const { signupToken } = (await http().post('/api/auth/verify-email').send({ email, code }).expect(200)).body as { signupToken: string };
      await http()
        .post('/api/auth/complete-profile')
        .set('Authorization', `Bearer ${signupToken}`)
        .send({ role: 'DOCTOR', firstName: 'No', lastName: 'Sessions', specialtyId: original.specialtyId, clinicId: original.clinicId, consultationFee: 100 })
        .expect(201);
      return (await listed('No Sessions'))[0];
    }
  });

  describe('doctor cancels an appointment', () => {
    type Cancelled = {
      id: string;
      status: string;
      cancelReason: string | null;
      cancelledBy: string | null;
      cancelledAt: string | null;
      patient?: { name: string };
    };
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const day = (n: number) => addDays(today, n);
    const cancelAs = (token: string, id: string, body?: object) =>
      http().post(`/api/doctor-portal/appointments/${id}/cancel`).set(auth(token)).send(body);
    const bookId = async (token: string, date: string, time: string) =>
      (await book(token, date, time).expect(201)).body.id as string;
    const rowOf = async (id: string) =>
      (await db.query('SELECT status, cancel_reason, cancelled_at, cancelled_by_user_id FROM appointments WHERE id = $1', [id])).rows[0];
    const userId = async (email: string) => (await db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as string;
    const activeOn = async (date: string) =>
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM appointments WHERE doctor_id = $1 AND appointment_date = $2 AND status IN ('PENDING','CONFIRMED')",
            [doctorId, date],
          )
        ).rows[0].n,
      );
    const mine = async (token: string) => (await http().get('/api/appointments/mine').set(auth(token)).expect(200)).body as Cancelled[];
    const doctorList = async () =>
      (await http().get('/api/doctor-portal/appointments?scope=all').set(auth(doctorToken)).expect(200)).body as Cancelled[];
    // An appointment directly in the database, for states the API will not create (in the past, already completed).
    const insertAppointment = async (date: string, startTime: string, status: string) => {
      const { rows } = await db.query<{ patient_id: string; user_id: string }>(
        'SELECT p.id AS patient_id, u.id AS user_id FROM patients p JOIN users u ON u.id = p.user_id WHERE u.email = $1',
        ['patient1@test.local'],
      );
      return (
        await db.query<{ id: string }>(
          `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status)
           VALUES ($1, $2, $3, $4, $5, $5::time + interval '15 minutes', $6) RETURNING id`,
          [rows[0].patient_id, doctorId, rows[0].user_id, date, startTime, status],
        )
      ).rows[0].id;
    };

    // Starts a test from an empty calendar, so bookings left by earlier tests cannot fill a session.
    const cancelAllActive = () =>
      db.query(
        "UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'test cleanup', cancelled_at = now(), cancelled_by_user_id = booked_by_user_id WHERE status IN ('PENDING','CONFIRMED')",
      );

    let otherDoctorToken: string;

    beforeAll(async () => {
      // A second doctor, to prove a doctor cannot touch another doctor's appointments.
      const hash = await hashPassword(PASSWORD);
      const otherUserId = (
        await db.query<{ id: string }>(
          "INSERT INTO users (name, email, password_hash, role) VALUES ('Dr. Other Doctor', 'other.doctor@test.local', $1, 'DOCTOR') RETURNING id",
          [hash],
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
         SELECT $1, clinic_id, specialty_id, 15, 10, 100 FROM doctors WHERE id = $2`,
        [otherUserId, doctorId],
      );
      otherDoctorToken = await login('other.doctor@test.local');
    });

    it('cancels with a reason, records who and when, frees the slot and capacity, and tells the patient', async () => {
      const date = day(29);
      const first = await bookId(patientToken, date, '10:00');
      await bookId(otherPatientToken, date, '10:15');
      expect((await slotsFor(date)).slots.find((slot) => slot.startTime === '10:30')?.status).toBe('FULL');

      const response = await cancelAs(doctorToken, first, { reason: '  Doctor is unwell  ' }).expect(200);
      expect(response.body).toMatchObject({
        id: first,
        status: 'CANCELLED',
        cancelReason: 'Doctor is unwell',
        cancelledBy: 'DOCTOR',
        patient: { name: 'Pat One' },
      });
      expect(response.body.cancelledAt).not.toBeNull();

      const row = await rowOf(first);
      expect(row.cancelled_by_user_id).toBe(await userId('doctor@test.local'));
      expect(row.cancelled_at).not.toBeNull();

      // The slot and the place in the session's capacity are free again, and someone else can book them.
      const after = await slotsFor(date);
      expect(after.sessions[0]).toMatchObject({ capacity: 2, booked: 1, remaining: 1 });
      expect(after.slots.map((slot) => slot.status)).toEqual(['AVAILABLE', 'BOOKED', 'AVAILABLE', 'AVAILABLE']);
      await bookId(otherPatientToken, date, '10:00');
      expect(await activeOn(date)).toBe(2);

      // The patient's history shows the status, the reason and that the doctor cancelled it.
      expect((await mine(patientToken)).find((a) => a.id === first)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Doctor is unwell',
        cancelledBy: 'DOCTOR',
      });
      expect((await doctorList()).find((a) => a.id === first)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'DOCTOR', cancelReason: 'Doctor is unwell' });

      // Nothing more can be done to it.
      const again = await cancelAs(doctorToken, first, { reason: 'Second try' }).expect(409);
      expect(again.body.message).toMatch(/already cancelled/);
      await http().post(`/api/appointments/${first}/cancel`).set(auth(patientToken)).send({}).expect(409);
      await http().post(`/api/appointments/${first}/reschedule`).set(auth(patientToken)).send({ date: day(30), startTime: '10:00' }).expect(409);
    });

    it('records the patient as the canceller when the patient cancels or reschedules', async () => {
      const id = await bookId(patientToken, day(30), '10:30');
      await http().post(`/api/appointments/${id}/cancel`).set(auth(patientToken)).send({ reason: 'Changed plans' }).expect(200);
      const patientUserId = await userId('patient1@test.local');
      expect((await rowOf(id)).cancelled_by_user_id).toBe(patientUserId);
      expect((await mine(patientToken)).find((a) => a.id === id)).toMatchObject({ cancelledBy: 'PATIENT', cancelReason: 'Changed plans' });
      expect((await doctorList()).find((a) => a.id === id)).toMatchObject({ cancelledBy: 'PATIENT' });

      const original = await bookId(patientToken, day(30), '10:00');
      await http().post(`/api/appointments/${original}/reschedule`).set(auth(patientToken)).send({ date: day(30), startTime: '10:15' }).expect(201);
      expect((await rowOf(original)).cancelled_by_user_id).toBe(patientUserId);
    });

    it('requires a real reason and rejects anything else in the request', async () => {
      const id = await bookId(patientToken, day(28), '10:00');
      await cancelAs(doctorToken, id).expect(400); // no body at all
      await cancelAs(doctorToken, id, {}).expect(400);
      await cancelAs(doctorToken, id, { reason: '' }).expect(400);
      await cancelAs(doctorToken, id, { reason: '   ' }).expect(400);
      const short = await cancelAs(doctorToken, id, { reason: 'ab' }).expect(400);
      expect(JSON.stringify(short.body.message)).toMatch(/reason: must be at least 3 characters/);
      await cancelAs(doctorToken, id, { reason: 'x'.repeat(201) }).expect(400);
      await cancelAs(doctorToken, id, { reason: 123 }).expect(400);
      await cancelAs(doctorToken, id, { reason: 'Valid reason', notify: true }).expect(400);
      expect((await rowOf(id)).status).toBe('CONFIRMED'); // every rejected request left it alone
    });

    it('is only for the doctor who owns the appointment, and only for active upcoming ones', async () => {
      const id = await bookId(patientToken, day(28), '10:15');
      const body = { reason: 'Not allowed' };
      await cancelAs(patientToken, id, body).expect(403);
      await http().post(`/api/doctor-portal/appointments/${id}/cancel`).send(body).expect(401);
      await cancelAs('garbage', id, body).expect(401);
      await cancelAs(otherDoctorToken, id, body).expect(404); // another doctor's appointment looks like a missing one
      await cancelAs(doctorToken, 'not-a-uuid', body).expect(400);
      await cancelAs(doctorToken, '00000000-0000-4000-8000-000000000000', body).expect(404);
      expect((await rowOf(id)).status).toBe('CONFIRMED');

      const past = await insertAppointment(addDays(today, -1), '03:00', 'CONFIRMED');
      const pastResponse = await cancelAs(doctorToken, past, body).expect(409);
      expect(pastResponse.body.message).toMatch(/already started or passed/);
      expect((await rowOf(past)).status).toBe('CONFIRMED');

      const completed = await insertAppointment(day(28), '04:00', 'COMPLETED');
      const completedResponse = await cancelAs(doctorToken, completed, body).expect(409);
      expect(completedResponse.body.message).toMatch(/already completed/);
      expect((await rowOf(completed)).status).toBe('COMPLETED');
    });

    it('lets only one of a doctor and a patient cancelling at the same moment win', async () => {
      await cancelAllActive();
      const id = await bookId(patientToken, day(28), '10:30');
      const results = await Promise.all([
        cancelAs(doctorToken, id, { reason: 'Doctor unavailable' }),
        http().post(`/api/appointments/${id}/cancel`).set(auth(patientToken)).send({ reason: 'Patient changed mind' }),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);

      const row = await rowOf(id);
      const doctorWon = results[0].status === 200;
      expect(row.cancelled_by_user_id).toBe(await userId(doctorWon ? 'doctor@test.local' : 'patient1@test.local'));
      expect(row.cancel_reason).toBe(doctorWon ? 'Doctor unavailable' : 'Patient changed mind'); // one consistent record, not a mix
    });

    it('lets a doctor with upcoming bookings clear them, which unblocks changing the slot length', async () => {
      await cancelAllActive();
      const id = await bookId(patientToken, day(27), '10:00');
      const put = (minutes: number) =>
        http().put('/api/doctor-portal/settings').set(auth(doctorToken)).send({ consultationMinutes: minutes });

      expect((await put(30).expect(409)).body.message).toMatch(/upcoming appointment/);
      await cancelAs(doctorToken, id, { reason: 'Clinic closed that day' }).expect(200);
      await put(30).expect(200);
      await put(15).expect(200);
    });
  });
});
