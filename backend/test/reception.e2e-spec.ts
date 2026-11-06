import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EMAIL_SENDER } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
let dayCounter = 0;
const nextDay = () => addDays(today, 2 + (dayCounter++ % 18));
const PATIENTS = 6;

describe('Receptionist workspace (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorA: string; // at the receptionist's clinic
  let doctorB: string; // at another clinic
  let receptionistId: string;
  let receptionistToken: string;
  let unassignedToken: string;
  let doctorToken: string;
  const patientIds: string[] = [];
  const patientTokens: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;

  const bookFor = (patient: number, date: string, startTime: string, doctorId = doctorA, token = receptionistToken) =>
    http().post('/api/receptionist/appointments').set(as(token)).send({ patientId: patientIds[patient], doctorId, date, startTime });
  const bookOwn = (patient: number, date: string, startTime: string, doctorId = doctorA) =>
    http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime });
  const slots = async (date: string, doctorId = doctorA) => (await http().get(`/api/doctors/${doctorId}/slots`).query({ date }).expect(200)).body.slots as { startTime: string; status: string; remaining?: number }[];
  const active = (date: string) =>
    rows<{ start_time: string; slot_number: number; patient_id: string }>(
      "SELECT start_time::text, slot_number, patient_id FROM appointments WHERE appointment_date = $1 AND status IN ('PENDING','CONFIRMED') ORDER BY start_time, slot_number",
      [date],
    );
  const oneTime = (doctorId: string, date: string, start: string, end: string, mode: 'STREAM' | 'WAVE', perSlot: number) =>
    db.query(
      `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
       VALUES ($1, 'ONE_TIME', $2, $3, $4, $5, $6, 30)`,
      [doctorId, date, start, end, mode, perSlot],
    );

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);

    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicA = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic A', '1 A St') RETURNING id")).rows[0].id as string;
    const clinicB = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic B', '2 B St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string, clinicId: string) =>
      (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
           VALUES ($1, $2, $3, 30, 20, 500) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId],
        )
      ).rows[0].id as string;
    doctorA = await makeDoctor('Dr. Alpha', 'alpha@test.local', clinicA);
    doctorB = await makeDoctor('Dr. Beta', 'beta@test.local', clinicB);
    receptionistId = await user('Reena Reception', 'reception@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2)', [receptionistId, clinicA]);
    await user('Una Unassigned', 'unassigned@test.local', 'RECEPTIONIST');
    for (let n = 1; n <= PATIENTS; n++) {
      const id = await user(n === 1 ? 'Priya Patel' : `Patient ${n}`, `p${n}@test.local`, 'PATIENT');
      patientIds.push((await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [id, `+91900000000${n}`])).rows[0].id as string);
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => undefined }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    receptionistToken = await login('reception@test.local');
    unassignedToken = await login('unassigned@test.local');
    doctorToken = await login('alpha@test.local');
    for (let n = 1; n <= PATIENTS; n++) patientTokens.push(await login(`p${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
  });

  describe('who may use it', () => {
    it('is for receptionists only', async () => {
      await http().get('/api/receptionist/doctors').expect(401);
      await http().get('/api/receptionist/doctors').set(as(patientTokens[0])).expect(403);
      await http().get('/api/receptionist/doctors').set(as(doctorToken)).expect(403);
      await http().post('/api/receptionist/appointments').set(as(patientTokens[0])).send({ patientId: patientIds[0], doctorId: doctorA, date: nextDay(), startTime: '09:00' }).expect(403);
    });

    it('shows only the doctors of the receptionist\'s own clinics', async () => {
      const mine = (await http().get('/api/receptionist/doctors').set(as(receptionistToken)).expect(200)).body as { id: string; name: string; clinic: { name: string } }[];
      expect(mine.map((doctor) => doctor.name)).toEqual(['Dr. Alpha']);
      expect(mine[0].clinic.name).toBe('Clinic A');
      expect((await http().get('/api/receptionist/doctors').set(as(unassignedToken)).expect(200)).body).toEqual([]);
    });

    it('refuses to book, move or cancel at another clinic', async () => {
      const date = nextDay();
      await oneTime(doctorB, date, '09:00', '10:00', 'STREAM', 1);
      await bookFor(0, date, '09:00', doctorB).expect(403);
      const theirs = (await bookOwn(1, date, '09:00', doctorB).expect(201)).body;
      await http().post(`/api/receptionist/appointments/${theirs.id}/cancel`).set(as(receptionistToken)).send({}).expect(404);
      await http().post(`/api/receptionist/appointments/${theirs.id}/reschedule`).set(as(receptionistToken)).send({ date, startTime: '09:30' }).expect(404);
      await bookFor(0, date, '09:00', doctorA, unassignedToken).expect(403);
      expect(await rows("SELECT status FROM appointments WHERE id = $1", [theirs.id])).toEqual([{ status: 'CONFIRMED' }]);
    });
  });

  describe('finding patients', () => {
    it('searches registered patients by name, email or phone, and only returns what reception needs', async () => {
      const byName = (await http().get('/api/receptionist/patients').query({ search: 'priya' }).set(as(receptionistToken)).expect(200)).body as Record<string, unknown>[];
      expect(byName).toEqual([{ id: patientIds[0], name: 'Priya Patel', email: 'p1@test.local', phone: '+919000000001' }]);
      expect((await http().get('/api/receptionist/patients').query({ search: 'p3@test' }).set(as(receptionistToken)).expect(200)).body).toHaveLength(1);
      expect((await http().get('/api/receptionist/patients').query({ search: '9000000004' }).set(as(receptionistToken)).expect(200)).body).toHaveLength(1);
      expect((await http().get('/api/receptionist/patients').query({ search: 'Patient' }).set(as(receptionistToken)).expect(200)).body.length).toBeLessThanOrEqual(10);
      await http().get('/api/receptionist/patients').query({ search: 'p' }).set(as(receptionistToken)).expect(400);
      await http().get('/api/receptionist/patients').query({ search: 'priya' }).set(as(patientTokens[0])).expect(403);
    });

    it('treats % and _ as plain characters', async () => {
      expect((await http().get('/api/receptionist/patients').query({ search: '%%' }).set(as(receptionistToken)).expect(200)).body).toEqual([]);
    });
  });

  describe('booking Wave and Stream slots', () => {
    it('books a patient into a Wave slot until its places run out, then answers 409', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '09:00', '10:00', 'WAVE', 2);
      expect((await slots(date))[0]).toMatchObject({ startTime: '09:00', status: 'AVAILABLE', remaining: 2 });
      const first = (await bookFor(0, date, '09:00').expect(201)).body;
      expect(first).toMatchObject({ status: 'CONFIRMED', date, startTime: '09:00' });
      await bookFor(1, date, '09:00').expect(201);
      const refused = await bookFor(2, date, '09:00').expect(409);
      expect(refused.body.message).toMatch(/slot is full/i);
      expect((await slots(date))[0]).toMatchObject({ status: 'BOOKED', remaining: 0 });
      expect((await active(date)).map((row) => row.slot_number)).toEqual([1, 2]);
      expect(await rows('SELECT booked_by_user_id FROM appointments WHERE id = $1', [first.id])).toEqual([{ booked_by_user_id: receptionistId }]);
      await bookFor(2, date, '09:30').expect(201); // the other slot has room
    });

    it('takes exactly one patient in a Stream slot', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '14:00', '15:00', 'STREAM', 1);
      await bookFor(0, date, '14:00').expect(201);
      const refused = await bookFor(1, date, '14:00').expect(409);
      expect(refused.body.message).toMatch(/just been booked/i);
      expect(await active(date)).toHaveLength(1);
    });

    it('confirms at once, with no payment step, even though the doctor charges a fee', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '14:00', '15:00', 'STREAM', 1);
      const booked = (await bookFor(0, date, '14:00').expect(201)).body;
      expect(booked.status).toBe('CONFIRMED');
      expect(booked.holdExpiresAt).toBeNull();
      expect(booked.checkout).toBeUndefined();
      expect(await rows('SELECT count(*)::int AS n FROM payments')).toEqual([{ n: 0 }]);
    });

    it('validates the request', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '09:00', '10:00', 'WAVE', 2);
      await http().post('/api/receptionist/appointments').set(as(receptionistToken)).send({ doctorId: doctorA, date, startTime: '09:00' }).expect(400); // no patient
      await http().post('/api/receptionist/appointments').set(as(receptionistToken)).send({ patientId: patientIds[0], doctorId: doctorA, date: '2030-02-30', startTime: '09:00' }).expect(400);
      await http().post('/api/receptionist/appointments').set(as(receptionistToken)).send({ patientId: patientIds[0], doctorId: doctorA, date, startTime: '09:00', extra: 1 }).expect(400);
      await http().post('/api/receptionist/appointments').set(as(receptionistToken)).send({ patientId: '00000000-0000-4000-8000-000000000000', doctorId: doctorA, date, startTime: '09:00' }).expect(404);
      await http().post('/api/receptionist/appointments').set(as(receptionistToken)).send({ patientId: patientIds[0], doctorId: '00000000-0000-4000-8000-000000000000', date, startTime: '09:00' }).expect(404);
      await bookFor(0, date, '09:10').expect(400); // not a slot
      expect(await active(date)).toEqual([]);
    });

    it('never lets a receptionist and patients overbook a slot when they race for the last places', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '09:00', '10:00', 'WAVE', 2);
      const responses = await Promise.all([bookFor(0, date, '09:00'), bookFor(1, date, '09:00'), bookFor(2, date, '09:00'), bookOwn(3, date, '09:00'), bookOwn(4, date, '09:00'), bookOwn(5, date, '09:00')]);
      expect(responses.filter((response) => response.status === 201)).toHaveLength(2);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(4);
      expect((await active(date)).map((row) => row.slot_number)).toEqual([1, 2]);
    });
  });

  describe('appointments, cancelling and moving', () => {
    it('lists the active appointments of the receptionist\'s clinics, by date and doctor', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '09:00', '10:00', 'WAVE', 2);
      await oneTime(doctorB, date, '09:00', '10:00', 'STREAM', 1);
      await bookFor(0, date, '09:00').expect(201);
      await bookOwn(1, date, '09:00').expect(201);
      await bookOwn(2, date, '09:00', doctorB).expect(201);
      const list = (await http().get('/api/receptionist/appointments').query({ date }).set(as(receptionistToken)).expect(200)).body as { patient: { name: string }; doctor: { name: string }; slotNumber: number; slotCapacity: number }[];
      expect(list.map((entry) => [entry.patient.name, entry.doctor.name, entry.slotNumber, entry.slotCapacity])).toEqual([
        ['Priya Patel', 'Dr. Alpha', 1, 2],
        ['Patient 2', 'Dr. Alpha', 2, 2],
      ]);
      expect((await http().get('/api/receptionist/appointments').query({ doctorId: doctorA }).set(as(receptionistToken)).expect(200)).body).toHaveLength(2);
      expect((await http().get('/api/receptionist/appointments').set(as(unassignedToken)).expect(200)).body).toEqual([]);
    });

    it('cancels for a patient, frees the place for someone else, and records who cancelled', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '09:00', '10:00', 'WAVE', 1 + 1);
      const first = (await bookFor(0, date, '09:00').expect(201)).body;
      await bookFor(1, date, '09:00').expect(201);
      await bookFor(2, date, '09:00').expect(409);
      await http().post(`/api/receptionist/appointments/${first.id}/cancel`).set(as(receptionistToken)).send({ reason: 'Patient phoned' }).expect(200);
      expect(await rows('SELECT status, cancel_reason, cancelled_by_user_id FROM appointments WHERE id = $1', [first.id])).toEqual([
        { status: 'CANCELLED', cancel_reason: 'Patient phoned', cancelled_by_user_id: receptionistId },
      ]);
      await bookFor(2, date, '09:00').expect(201); // the freed place
      expect((await active(date)).map((row) => row.slot_number)).toEqual([1, 2]);
      await http().post(`/api/receptionist/appointments/${first.id}/cancel`).set(as(receptionistToken)).send({}).expect(409); // already cancelled
    });

    it('moves a patient to another slot, and refuses a full one without touching the original', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '09:00', '10:00', 'WAVE', 1);
      const mine = (await bookFor(0, date, '09:00').expect(201)).body;
      await bookFor(1, date, '09:30').expect(201);
      await http().post(`/api/receptionist/appointments/${mine.id}/reschedule`).set(as(receptionistToken)).send({ date, startTime: '09:30' }).expect(409);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CONFIRMED' }]);
      await http().post('/api/receptionist/appointments/00000000-0000-4000-8000-000000000000/reschedule').set(as(receptionistToken)).send({ date, startTime: '09:00' }).expect(404);
      await oneTime(doctorA, addDays(date, 1), '09:00', '10:00', 'WAVE', 2);
      const moved = (await http().post(`/api/receptionist/appointments/${mine.id}/reschedule`).set(as(receptionistToken)).send({ date: addDays(date, 1), startTime: '09:00' }).expect(201)).body;
      expect(moved).toMatchObject({ status: 'CONFIRMED', date: addDays(date, 1), startTime: '09:00' });
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CANCELLED' }]);
      expect(await rows('SELECT patient_id, rescheduled_from_id FROM appointments WHERE id = $1', [moved.id])).toEqual([{ patient_id: patientIds[0], rescheduled_from_id: mine.id }]);
    });
  });

  describe('what patients still do themselves', () => {
    it('a patient still books, sees and cancels their own appointment, and a receptionist\'s booking shows up for them', async () => {
      const date = nextDay();
      await oneTime(doctorA, date, '09:00', '10:00', 'WAVE', 2);
      await bookFor(0, date, '09:00').expect(201);
      const mine = (await http().get('/api/appointments/mine').set(as(patientTokens[0])).expect(200)).body as { id: string; status: string }[];
      expect(mine).toHaveLength(1);
      await http().post(`/api/appointments/${mine[0].id}/cancel`).set(as(patientTokens[0])).send({}).expect(200);
      const own = (await bookOwn(0, date, '09:00').expect(201)).body;
      expect(own.status).toBe('CONFIRMED'); // with payments off, as before
      await http().post(`/api/appointments/${own.id}/cancel`).set(as(patientTokens[1])).send({}).expect(404); // someone else's
    });
  });
});
