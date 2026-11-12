// Capacity management: the doctor can raise or lower the patients per slot of a session.
//  - raising it immediately opens more places; lowering it never cancels or moves anyone, and a slot that is then over capacity takes no new
//    bookings until enough patients have left it (cancelled, rescheduled), when availability is recalculated from the live bookings;
//  - concurrent bookings never exceed the capacity. The mail provider is mocked.

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
process.env.RESEND_API_KEY = '';
process.env.BREVO_API_KEY = '';
process.env.BACKGROUND_JOBS = 'false';
process.env.SCHEDULE_REMINDER_COOLDOWN_HOURS = '24';

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);
const PATIENTS = 12;

describe('Slot capacity management (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  const patientTokens: string[] = [];
  const sent: { to: string; subject: string }[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (patient: number, date: string, startTime: string) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime });
  const reschedule = (patient: number, id: string, date: string, startTime: string) => http().post(`/api/appointments/${id}/reschedule`).set(as(patientTokens[patient])).send({ date, startTime });
  const session = async (date: string, extra: { start?: string; end?: string; perSlot?: number } = {}) =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
         VALUES ($1, 'ONE_TIME', $2, $3, $4, 'WAVE', $5, 30) RETURNING id`,
        [doctorId, date, extra.start ?? '09:00', extra.end ?? '10:00', extra.perSlot ?? 2],
      )
    ).rows[0].id as string;
  /** Moves the clock forward for the coordination records: every contact looks `hours` older. */
  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);
    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic A', '1 A St') RETURNING id")).rows[0].id as string;
    doctorId = (
      await db.query(`INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id`, [
        await user('Dr. Coordinator', 'coord@test.local', 'DOCTOR'),
        clinicId,
        specialtyId,
      ])
    ).rows[0].id as string;
    for (let n = 1; n <= PATIENTS; n++) {
      const id = await user(`Patient ${n}`, `co${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000400${String(n).padStart(2, '0')}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: async (message: { to: string; subject: string }) => {
          sent.push({ to: message.to, subject: message.subject });
          return { reference: 'em_1' };
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('coord@test.local');
    for (let n = 1; n <= PATIENTS; n++) patientTokens.push(await login(`co${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
    sent.length = 0;
  });

  // After every test: nobody was ever cancelled by coordination, and no place was held for anyone.
  afterEach(async () => {
    expect(await rows("SELECT id FROM appointments WHERE status = 'CANCELLED' AND cancel_reason IS DISTINCT FROM 'Rescheduled by patient' AND cancel_reason IS DISTINCT FROM 'test'")).toEqual([]);
    expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time HAVING count(*) > max(slot_capacity)")).toEqual([]);
  });

  const capacity = (id: string, capacityPerSlot: number, token = doctorToken) => http().post(`/api/doctor-portal/availability/${id}/capacity`).set(as(token)).send({ capacityPerSlot });
  const slot = async (date: string, startTime: string) => ((await http().get(`/api/doctors/${doctorId}/slots?date=${date}`).expect(200)).body.slots as { startTime: string; status: string; remaining?: number; capacityPerSlot?: number }[]).find((s) => s.startTime === startTime)!;
  const confirmed = async () => Number((await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CONFIRMED'"))[0].n);
  const cancel = (patient: number, id: string) => http().post(`/api/appointments/${id}/cancel`).set(as(patientTokens[patient])).send({ reason: 'test' });
  const rowView = async (id: string) => ((await http().get('/api/doctor-portal/availability').set(as(doctorToken)).expect(200)).body.oneTime as { id: string; capacityPerSlot: number; overCapacity: { slots: number; maxBooked: number } | null }[]).find((r) => r.id === id)!;

  describe('raising the capacity', () => {
    it('opens the extra places straight away, up to the new limit and no further', async () => {
      const id = await session(day(6), { perSlot: 3 });
      for (const p of [0, 1, 2]) await book(p, day(6), '09:00').expect(201);
      await book(3, day(6), '09:00').expect(409);
      const res = await capacity(id, 5).expect(200);
      expect(res.body).toMatchObject({ capacityPerSlot: 5, previousCapacityPerSlot: 3, overCapacitySlots: 0 });
      expect(await slot(day(6), '09:00')).toMatchObject({ status: 'AVAILABLE', remaining: 2, capacityPerSlot: 5 });
      await book(3, day(6), '09:00').expect(201);
      await book(4, day(6), '09:00').expect(201);
      await book(5, day(6), '09:00').expect(409);
      expect(await slot(day(6), '09:00')).toMatchObject({ status: 'BOOKED', remaining: 0 });
    });
  });

  describe('lowering the capacity below the bookings', () => {
    it('keeps every confirmed appointment, marks the slot over capacity, blocks new bookings, and recalculates as patients leave', async () => {
      const id = await session(day(6), { start: '09:00', end: '10:30', perSlot: 3 });
      const booked: { id: string }[] = [];
      for (const p of [0, 1, 2]) booked.push((await book(p, day(6), '09:00').expect(201)).body);

      const res = await capacity(id, 1).expect(200);
      expect(res.body).toMatchObject({ capacityPerSlot: 1, previousCapacityPerSlot: 3, overCapacitySlots: 1, maxBooked: 3 });
      expect(await confirmed()).toBe(3); // nobody was cancelled or moved
      expect(await rows('SELECT 1 FROM schedule_change_appointments')).toEqual([]);
      expect(await rows("SELECT 1 FROM notifications WHERE kind LIKE 'needs-new-time%'")).toEqual([]);
      expect(await rowView(id)).toMatchObject({ capacityPerSlot: 1, overCapacity: { slots: 1, maxBooked: 3 } });

      await book(3, day(6), '09:00').expect(409); // over capacity: no new bookings
      expect(await slot(day(6), '09:00')).toMatchObject({ status: 'BOOKED', remaining: 0 });
      await book(3, day(6), '09:30').expect(201); // other slots follow the new limit of 1
      await book(4, day(6), '09:30').expect(409);

      await cancel(0, booked[0].id).expect(200); // 2 left for 1 place: still over capacity, still blocked
      await book(5, day(6), '09:00').expect(409);
      expect(await rowView(id)).toMatchObject({ overCapacity: { slots: 1, maxBooked: 2 } });

      await reschedule(1, booked[1].id, day(6), '10:00').expect(201); // a patient moves themselves to a free slot
      expect(await confirmed()).toBe(3);
      expect((await rowView(id)).overCapacity).toBeNull(); // 1 left for 1 place: full, no longer over
      await book(5, day(6), '09:00').expect(409);
      expect(await slot(day(6), '09:00')).toMatchObject({ status: 'BOOKED', remaining: 0 });

      await cancel(2, booked[2].id).expect(200); // the last one leaves: the place is free again
      expect(await slot(day(6), '09:00')).toMatchObject({ status: 'AVAILABLE', remaining: 1 });
      await book(5, day(6), '09:00').expect(201);
      await book(6, day(6), '09:00').expect(409);
    });
  });

  describe('checks and permissions', () => {
    it('only changes a Wave session, within 1-100, for the doctor who owns it', async () => {
      const wave = await session(day(6), { perSlot: 3 });
      const stream = (
        await db.query(
          `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
           VALUES ($1, 'ONE_TIME', $2, '11:00', '12:00', 'STREAM', 1, 30) RETURNING id`,
          [doctorId, day(6)],
        )
      ).rows[0].id as string;
      await capacity(stream, 2).expect(400);
      await capacity(wave, 0).expect(400);
      await capacity(wave, 101).expect(400);
      await capacity(wave, 2.5).expect(400);
      await capacity(wave, 4, patientTokens[0]).expect(403);
      await capacity('00000000-0000-4000-8000-000000000000', 4).expect(404);
      await http().post(`/api/doctor-portal/availability/${wave}/capacity`).send({ capacityPerSlot: 4 }).expect(401);
      expect((await rows('SELECT capacity_per_slot FROM availability WHERE id = $1', [wave]))[0]).toEqual({ capacity_per_slot: 3 });
    });
  });

  describe('concurrency', () => {
    it('never lets simultaneous bookings exceed the capacity', async () => {
      await session(day(6), { perSlot: 2 });
      const results = await Promise.all([0, 1, 2, 3, 4, 5].map((p) => book(p, day(6), '09:00')));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await confirmed()).toBe(2);
    });

    it('survives bookings racing a capacity decrease: no server errors, no duplicate seats, and the final state obeys the rules', async () => {
      const id = await session(day(6), { perSlot: 4 });
      await book(0, day(6), '09:00').expect(201);
      const results = await Promise.all([capacity(id, 1), ...[1, 2, 3, 4, 5].map((p) => book(p, day(6), '09:00'))]);
      expect(results.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
      expect(results[0].status).toBe(200);
      const seats = await rows("SELECT slot_number FROM appointments WHERE status = 'CONFIRMED' AND start_time = '09:00'");
      expect(new Set(seats.map((r) => r.slot_number)).size).toBe(seats.length);
      const settled = await confirmed();
      await book(6, day(6), '09:00').expect(409); // whatever got in, the slot now takes no more (capacity 1, at least 1 booked)
      expect(await confirmed()).toBe(settled);
    });
  });
});
