// A patient removing a PAST booking from their own list ("hide", not delete).
//  - only the patient's own list changes: doctor views, payments, receipts and refunds still show the booking;
//  - allowed for cancelled, completed and no-show bookings only, never for active ones, and never while money is unsettled;
//  - ownership: someone else's booking is "not found"; it is idempotent; the assistant's lookups skip hidden bookings too;
//  - a database that has not been migrated to 014 yet keeps working (the list is unchanged; only hiding says it is not available).
// The real app, database and services run; only the model is replaced.

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { LLM_CLIENT, type LlmClient, type LlmRequest, type LlmResponse } from '../src/assistant/llm/llm-client.js';
import { RateLimiter } from '../src/assistant/rate-limit.js';
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

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);

type Status = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

describe('patient: remove a past booking from my history (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  const patientIds: string[] = [];
  const patientUserIds: string[] = [];
  const patientTokens: string[] = [];
  let receptionToken: string;
  let seq = 0;

  let script: (request: LlmRequest) => LlmResponse | Error = () => ({ text: 'ok', toolCalls: [] });
  const fakeModel: LlmClient = {
    configured: true,
    generate: async (req) => {
      const answer = script(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const hide = (token: string, id: string) => http().post(`/api/appointments/${id}/hide-from-history`).set(as(token)).send({});
  const mine = async (patient = 0) => (await http().get('/api/appointments/mine').set(as(patientTokens[patient])).expect(200)).body as { id: string; status: string }[];

  /** A booking in a given state, with an optional payment and refund, written straight to the database. */
  const booking = async (options: { status: Status; patient?: number; date?: string; payment?: 'CREATED' | 'FAILED' | 'PAID' | 'EXPIRED'; refund?: 'PENDING' | 'PROCESSED' | 'FAILED' }) => {
    const patient = options.patient ?? 0;
    const n = ++seq;
    const time = `${String(8 + (n % 10)).padStart(2, '0')}:${n % 2 ? '00' : '30'}`;
    const cancelled = options.status === 'CANCELLED';
    const id = (
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, slot_capacity, slot_number, status, cancelled_at, cancelled_by_user_id, cancel_reason, hold_expires_at)
         VALUES ($1, $2, $3, $4, $5::time, ($5::time + interval '30 minutes'), 1, 1, $6, $7, $8, $9, $10) RETURNING id`,
        [
          patientIds[patient],
          doctorId,
          patientUserIds[patient],
          options.date ?? day(-(n + 2)),
          time,
          options.status,
          cancelled ? new Date() : null,
          cancelled ? patientUserIds[patient] : null,
          cancelled ? 'test' : null,
          options.status === 'PENDING' ? new Date(Date.now() + 600_000) : null,
        ],
      )
    ).rows[0].id as string;
    if (options.payment) {
      const paid = options.payment === 'PAID';
      const paymentId = (
        await db.query(
          `INSERT INTO payments (appointment_id, patient_id, razorpay_order_id, razorpay_payment_id, amount_paise, status, paid_at) VALUES ($1, $2, $3, $4, 50000, $5, $6) RETURNING id`,
          [id, patientIds[patient], `order_hide_${n}`, paid ? `pay_hide_${n}` : null, options.payment, paid ? new Date() : null],
        )
      ).rows[0].id as string;
      if (options.refund) {
        await db.query(`INSERT INTO refunds (payment_id, amount_paise, reason, status, idempotency_key, processed_at) VALUES ($1, 50000, 'cancelled', $2, $3, $4)`, [
          paymentId,
          options.refund,
          `hide-key-${n}`,
          options.refund === 'PROCESSED' ? new Date() : null,
        ]);
      }
    }
    return id;
  };
  const hiddenAt = async (id: string) => (await rows<{ hidden_by_patient_at: Date | null }>('SELECT hidden_by_patient_at FROM appointments WHERE id = $1', [id]))[0].hidden_by_patient_at;

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
    doctorId = (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 500) RETURNING id', [await user('Dr. Hide', 'hidoc@test.local', 'DOCTOR'), clinicId, specialtyId])).rows[0].id as string;
    for (let n = 1; n <= 2; n++) {
      const userId = await user(`Patient ${n}`, `hide${n}@test.local`, 'PATIENT');
      patientUserIds.push(userId);
      patientIds.push((await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [userId, `+91900001100${n}`])).rows[0].id as string);
    }
    await user('Rita Reception', 'hirec@test.local', 'RECEPTIONIST');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async () => ({ reference: 'em_1' }) })
      .overrideProvider(LLM_CLIENT)
      .useValue(fakeModel)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('hidoc@test.local');
    receptionToken = await login('hirec@test.local');
    for (let n = 1; n <= 2; n++) patientTokens.push(await login(`hide${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM refunds; DELETE FROM payment_events; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    (app.get(AssistantService) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter(10_000, 60_000);
    script = () => ({ text: 'ok', toolCalls: [] });
  });

  describe('who may do it', () => {
    it('only the patient who owns the booking: another patient, and a missing id, are "not found"', async () => {
      const id = await booking({ status: 'CANCELLED', patient: 0 });
      await hide(patientTokens[1], id).expect(404);
      await hide(patientTokens[0], '11111111-1111-4111-8111-111111111111').expect(404);
      expect(await hiddenAt(id)).toBeNull();
      expect((await mine(0)).map((row) => row.id)).toEqual([id]);
    });

    it('is for patients only: doctors, receptionists and signed-out callers are turned away', async () => {
      const id = await booking({ status: 'CANCELLED' });
      await hide(doctorToken, id).expect(403);
      await hide(receptionToken, id).expect(403);
      await http().post(`/api/appointments/${id}/hide-from-history`).send({}).expect(401);
      expect(await hiddenAt(id)).toBeNull();
    });

    it('rejects a bad id and an extra body', async () => {
      await hide(patientTokens[0], 'not-a-uuid').expect(400);
      const id = await booking({ status: 'CANCELLED' });
      await http().post(`/api/appointments/${id}/hide-from-history`).set(as(patientTokens[0])).send({ patientId: 'x' }).expect(400);
      expect(await hiddenAt(id)).toBeNull();
    });
  });

  describe('which bookings', () => {
    it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'] as const)('removes a %s booking from the list and changes nothing else about it', async (status) => {
      const id = await booking({ status });
      const before = (await rows('SELECT status, appointment_date::text, start_time::text, cancel_reason FROM appointments WHERE id = $1', [id]))[0];
      const res = await hide(patientTokens[0], id).expect(200);
      expect(res.body).toEqual({ id, hidden: true, alreadyHidden: false });
      expect(await hiddenAt(id)).toBeInstanceOf(Date);
      expect((await mine(0)).map((row) => row.id)).toEqual([]);
      expect((await rows('SELECT status, appointment_date::text, start_time::text, cancel_reason FROM appointments WHERE id = $1', [id]))[0]).toEqual(before);
    });

    it('refuses an active booking, confirmed or unpaid, with nothing changed', async () => {
      const confirmed = await booking({ status: 'CONFIRMED', date: day(5) });
      const pending = await booking({ status: 'PENDING', date: day(6) });
      for (const id of [confirmed, pending]) {
        const res = await hide(patientTokens[0], id).expect(409);
        expect(res.body).toMatchObject({ code: 'NOT_PAST', message: expect.stringMatching(/Only a cancelled or completed appointment/) });
        expect(await hiddenAt(id)).toBeNull();
      }
      expect((await mine(0)).map((row) => row.id).sort()).toEqual([confirmed, pending].sort());
    });

    it('refuses a past booking that is still marked confirmed (it is not finished until it is completed or cancelled)', async () => {
      const id = await booking({ status: 'CONFIRMED', date: day(-4) });
      await hide(patientTokens[0], id).expect(409);
    });
  });

  describe('money must be settled first', () => {
    it('refuses while a payment is still pending, a refund is on its way, or a refund failed', async () => {
      const unpaid = await booking({ status: 'CANCELLED', payment: 'CREATED' });
      const refunding = await booking({ status: 'CANCELLED', payment: 'PAID', refund: 'PENDING' });
      const failed = await booking({ status: 'CANCELLED', payment: 'PAID', refund: 'FAILED' });
      expect((await hide(patientTokens[0], unpaid).expect(409)).body).toMatchObject({ code: 'PAYMENT_UNSETTLED', message: expect.stringMatching(/payment.*not settled/) });
      expect((await hide(patientTokens[0], refunding).expect(409)).body).toMatchObject({ code: 'REFUND_PENDING', message: expect.stringMatching(/refund.*still being processed/) });
      expect((await hide(patientTokens[0], failed).expect(409)).body).toMatchObject({ code: 'REFUND_UNSETTLED', message: expect.stringMatching(/did not go through/) });
      for (const id of [unpaid, refunding, failed]) expect(await hiddenAt(id)).toBeNull();
      expect(await mine(0)).toHaveLength(3);
    });

    it('allows it once everything is settled: refunded, paid and finished, never paid, or an abandoned order', async () => {
      const refunded = await booking({ status: 'CANCELLED', payment: 'PAID', refund: 'PROCESSED' });
      const finished = await booking({ status: 'COMPLETED', payment: 'PAID' });
      const free = await booking({ status: 'CANCELLED' });
      const abandoned = await booking({ status: 'CANCELLED', payment: 'EXPIRED' });
      for (const id of [refunded, finished, free, abandoned]) await hide(patientTokens[0], id).expect(200);
      expect(await mine(0)).toEqual([]);
    });

    it('a refund that completes later makes the booking removable', async () => {
      const id = await booking({ status: 'CANCELLED', payment: 'PAID', refund: 'PENDING' });
      await hide(patientTokens[0], id).expect(409);
      await db.query("UPDATE refunds SET status = 'PROCESSED', processed_at = now() WHERE payment_id = (SELECT id FROM payments WHERE appointment_id = $1)", [id]);
      await hide(patientTokens[0], id).expect(200);
    });
  });

  describe('idempotent, and only the patient\'s own list changes', () => {
    it('asking again is answered, not repeated, and keeps the first time', async () => {
      const id = await booking({ status: 'CANCELLED' });
      await hide(patientTokens[0], id).expect(200);
      const first = await hiddenAt(id);
      const again = await hide(patientTokens[0], id).expect(200);
      expect(again.body).toEqual({ id, hidden: true, alreadyHidden: true });
      expect(await hiddenAt(id)).toEqual(first);
    });

    it('two requests at once hide it once', async () => {
      const id = await booking({ status: 'CANCELLED' });
      const [a, b] = await Promise.all([hide(patientTokens[0], id), hide(patientTokens[0], id)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.alreadyHidden, b.body.alreadyHidden].filter(Boolean)).toHaveLength(1);
    });

    it('doctor views, payments and receipts still show a hidden booking, and the other patient is unaffected', async () => {
      const id = await booking({ status: 'CANCELLED', payment: 'PAID', refund: 'PROCESSED' });
      const theirs = await booking({ status: 'CANCELLED', patient: 1 });
      await hide(patientTokens[0], id).expect(200);

      expect((await mine(0)).map((row) => row.id)).toEqual([]);
      expect((await mine(1)).map((row) => row.id)).toEqual([theirs]);
      expect(JSON.stringify(await mine(1))).not.toContain('hidden_by_patient_at');

      const doctorView = (await http().get('/api/doctor-portal/appointments?scope=all').set(as(doctorToken)).expect(200)).body as { id: string }[];
      expect(doctorView.map((row) => row.id)).toEqual(expect.arrayContaining([id, theirs]));

      const payments = (await http().get('/api/payments/mine').set(as(patientTokens[0])).expect(200)).body as { receiptNumber: string; displayStatus: string; appointment: { id: string } }[];
      expect(payments).toEqual([expect.objectContaining({ displayStatus: 'REFUNDED', receiptNumber: expect.stringMatching(/^pay_hide_/), appointment: expect.objectContaining({ id }) })]); // the receipt is still there
    });

    it('does not change how a booking is read or written elsewhere: a hidden booking is still a normal row with its payment and refund', async () => {
      const id = await booking({ status: 'CANCELLED', payment: 'PAID', refund: 'PROCESSED' });
      await hide(patientTokens[0], id).expect(200);
      expect(await rows('SELECT 1 FROM payments WHERE appointment_id = $1', [id])).toHaveLength(1);
      expect(await rows('SELECT 1 FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.appointment_id = $1', [id])).toHaveLength(1);
      expect((await rows<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [id]))[0].status).toBe('CANCELLED');
    });
  });

  describe('the assistant', () => {
    it('does not see a hidden booking, but still sees the others', async () => {
      const gone = await booking({ status: 'CANCELLED', date: day(-9) });
      const kept = await booking({ status: 'COMPLETED', date: day(-3) });
      await hide(patientTokens[0], gone).expect(200);
      script = (req) =>
        req.messages.some((message) => message.role === 'tool')
          ? { text: 'Here are your appointments.', toolCalls: [] }
          : { text: '', toolCalls: [{ id: 'c1', name: 'get_my_appointments', args: { scope: 'all' } }] };
      const seen: unknown[] = [];
      const original = script;
      script = (req) => {
        const tool = req.messages.find((message) => message.role === 'tool');
        if (tool && tool.role === 'tool') seen.push(...tool.results.map((result) => result.output));
        return original(req);
      };
      await http().post('/api/assistant/chat').set(as(patientTokens[0])).send({ messages: [{ role: 'user', content: 'show all my appointments' }] }).expect(200);
      const listed = JSON.stringify(seen);
      expect(listed).toContain(kept);
      expect(listed).not.toContain(gone);
    });
  });

  describe('a database that has not been migrated to 014 yet', () => {
    it('still lists appointments exactly as before, and says hiding is not available instead of failing', async () => {
      const id = await booking({ status: 'CANCELLED' });
      await db.query('ALTER TABLE appointments RENAME COLUMN hidden_by_patient_at TO hidden_by_patient_at_off');
      try {
        expect((await mine(0)).map((row) => row.id)).toEqual([id]); // the list does not break
        const res = await hide(patientTokens[0], id).expect(503);
        expect(res.body.message).toMatch(/not available yet.*migration 014/);
        // Other appointment queries are unaffected: the doctor's list, and payments.
        await http().get('/api/doctor-portal/appointments?scope=all').set(as(doctorToken)).expect(200);
        await http().get('/api/payments/mine').set(as(patientTokens[0])).expect(200);
      } finally {
        await db.query('ALTER TABLE appointments RENAME COLUMN hidden_by_patient_at_off TO hidden_by_patient_at');
      }
    });
  });
});
