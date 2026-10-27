// End-to-end tests for the booking flow against a real PostgreSQL test database.
// Requires TEST_DATABASE_URL (see .env.example); the schema there is dropped and rebuilt.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';

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

  const http = () => request(app.getHttpServer());
  const login = async (email: string) =>
    (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (token: string, date: string, startTime: string) =>
    http().post('/api/appointments').set('Authorization', `Bearer ${token}`).send({ doctorId, date, startTime });
  const slotsFor = async (date: string) =>
    (await http().get(`/api/doctors/${doctorId}/slots`).query({ date }).expect(200)).body as {
      sessions: { capacity: number; booked: number; remaining: number }[];
      slots: { startTime: string; status: string }[];
      unavailableReason: string | null;
    };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await resetDatabase(db);
    ({ doctorId } = await insertFixtures(db));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
});
