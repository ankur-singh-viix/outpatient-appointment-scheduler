// Phase 2 follow-up: (1) an interrupted confirmation is recovered by RECONCILING with the appointment data, never by re-running a change;
// (2) a move is validated as if the appointment being moved had already released its old time.
// Failures are injected into the real services at different points of the confirmation. The real app and database run; only the model,
// the payment gateway and the injected failures are simulated.

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { vi } from 'vitest';
import { AssistantActionsService } from '../src/assistant/actions/assistant-actions.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { LLM_CLIENT, type LlmClient, type LlmRequest, type LlmResponse } from '../src/assistant/llm/llm-client.js';
import { RateLimiter } from '../src/assistant/rate-limit.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { EMAIL_SENDER } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { PAYMENT_GATEWAY, type GatewayRefund, type PaymentGateway } from '../src/payments/payment-gateway.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
// Test credentials only. They exist nowhere else and unlock nothing.
const KEY_SECRET = 'e2e_razorpay_key_secret';
const WEBHOOK_SECRET = 'e2e_razorpay_webhook_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.PAYMENT_HOLD_MINUTES = '15';
process.env.REFUND_FULL_HOURS_BEFORE = '24';
process.env.REFUND_PARTIAL_HOURS_BEFORE = '2';
process.env.REFUND_PARTIAL_PERCENT = '50';
process.env.RESEND_API_KEY = '';
process.env.BREVO_API_KEY = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';
const FEE = 650;
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);

/** A stand-in for Razorpay: it opens orders and accepts refunds, answering as told. No network. */
class FakeGateway implements PaymentGateway {
  readonly enabled = true;
  readonly keyId = 'rzp_test_e2e';
  refundStatus: GatewayRefund['status'] = 'pending';
  private counter = 0;
  async createOrder(input: { amountPaise: number }) {
    return { id: `order_${++this.counter}`, amountPaise: input.amountPaise, currency: 'INR' };
  }
  async createRefund(input: { amountPaise: number }): Promise<GatewayRefund> {
    return { id: `rfnd_${++this.counter}`, status: this.refundStatus, amountPaise: input.amountPaise };
  }
  async fetchRefund(refundId: string): Promise<GatewayRefund> {
    return { id: refundId, status: 'pending', amountPaise: 0 };
  }
  async findRefundByNote(): Promise<GatewayRefund | null> {
    return null;
  }
}

describe('AI assistant, phase 2 follow-up: recovery and reschedule validation (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let paidDoctor: string; // Dr. Paid, fee Rs. 650
  let freeDoctor: string; // Dr. Free, no fee
  let doctorToken: string;
  const patientIds: string[] = [];
  const patientTokens: string[] = [];
  const gateway = new FakeGateway();

  let script: (request: LlmRequest) => LlmResponse | Error;
  const requests: LlmRequest[] = [];
  const fakeModel: LlmClient = {
    configured: true,
    generate: async (request) => {
      requests.push(structuredClone(request));
      const answer = script(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (patient: number, doctor: string, date: string, startTime: string) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId: doctor, date, startTime });
  const session = (doctor: string, date: string, perSlot = 1, start = '09:00', end = '11:00') =>
    db.query(
      `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes) VALUES ($1, 'ONE_TIME', $2, $3, $4, 'WAVE', $5, 30)`,
      [doctor, date, start, end, perSlot],
    );

  /** The model asks for these tools in one round and then answers. Returns the reply, the card (if any) and what the tools gave back. */
  const converse = async (token: string, calls: { name: string; args?: Record<string, unknown> }[], text = 'Please review the card.') => {
    requests.length = 0;
    script = (req) =>
      req.messages.some((message) => message.role === 'tool')
        ? { text, toolCalls: [] }
        : { text: '', toolCalls: calls.map((call, index) => ({ id: `c${index}`, name: call.name, args: call.args ?? {} })) };
    const res = await chat(token, 'please do it');
    const toolMessage = requests.at(-1)?.messages.find((message) => message.role === 'tool');
    const outputs = toolMessage && toolMessage.role === 'tool' ? toolMessage.results.map((result) => result.output as any) : [];
    return { res, card: (res.body.actions?.[0] ?? null) as { ref: string; kind: string; title: string; lines: { label: string; value: string }[]; note?: string; expiresAt: string } | null, outputs, shown: JSON.stringify(outputs) };
  };
  const chat = (token: string, content: string) => http().post('/api/assistant/chat').set(as(token)).send({ messages: [{ role: 'user', content }] });
  const prepare = (patient: number, name: string, args: Record<string, unknown>) => converse(patientTokens[patient], [{ name, args }]);
  const confirm = (token: string, ref: string) => http().post(`/api/assistant/actions/${ref}/confirm`).set(as(token)).send({});
  const dismiss = (token: string, ref: string) => http().post(`/api/assistant/actions/${ref}/dismiss`).set(as(token)).send({});
  const appointments = (where = 'TRUE') => rows<{ id: string; status: string; start_time: string; appointment_date: string; patient_id: string }>(`SELECT id, status, start_time::text, appointment_date::text, patient_id FROM appointments WHERE ${where} ORDER BY created_at`);
  const signature = (orderId: string, paymentId: string, secret = KEY_SECRET) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const verify = (token: string, orderId: string, paymentId = `pay_${randomUUID().slice(0, 8)}`, secret = KEY_SECRET) =>
    http().post('/api/payments/verify').set(as(token)).send({ razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature(orderId, paymentId, secret) });

  /** Books and confirms through the assistant, the way a patient does. Returns the confirm response body. */
  const bookViaAssistant = async (patient: number, doctor: string, date: string, startTime: string) => {
    const { card } = await prepare(patient, 'prepare_booking', { doctorId: doctor, date, startTime });
    expect(card).not.toBeNull();
    return (await confirm(patientTokens[patient], card!.ref).expect(200)).body;
  };
  /** A paid, confirmed appointment (booked through the assistant, paid through the existing verification). */
  const paidAppointment = async (patient: number, date = day(3), startTime = '09:00') => {
    const result = await bookViaAssistant(patient, paidDoctor, date, startTime);
    await verify(patientTokens[patient], result.checkout.orderId).expect(200);
    return result.appointment.id as string;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);
    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const ent = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinic = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic A', '1 A St') RETURNING id")).rows[0].id as string;
    const doctor = async (name: string, email: string, fee: number) =>
      (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, $4) RETURNING id', [await user(name, email, 'DOCTOR'), clinic, ent, fee])).rows[0].id as string;
    paidDoctor = await doctor('Dr. Paid', 'paid@test.local', FEE);
    freeDoctor = await doctor('Dr. Free', 'free@test.local', 0);
    for (let n = 1; n <= 5; n++) {
      const id = await user(`Patient ${n}`, `ax${n}@test.local`, 'PATIENT');
      patientIds.push(id);
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000600${n}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async () => ({ reference: 'em_1' }) })
      .overrideProvider(LLM_CLIENT)
      .useValue(fakeModel)
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('paid@test.local');
    for (let n = 1; n <= 5; n++) patientTokens.push(await login(`ax${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM assistant_actions; DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
    gateway.refundStatus = 'pending';
    requests.length = 0;
    (app.get(AssistantService) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter(1000, 60_000);
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  // helpers for these tests
  // ------------------------------------------------------------------------------------------------------------------------------
  const svc = () => app.get(AssistantActionsService) as unknown as { appointments: Record<string, (...args: unknown[]) => Promise<unknown>>; actions: { update: (...args: unknown[]) => Promise<unknown> } };
  const status = (token: string, ref: string) => http().get(`/api/assistant/actions/${ref}`).set(as(token));
  const age = (ref: string, seconds: number) => db.query("UPDATE assistant_actions SET decided_at = now() - ($2 || ' seconds')::interval WHERE id = $1", [ref, String(seconds)]);
  const row = async (ref: string) => (await rows<{ status: string; failure: string | null; result_appointment_id: string | null }>('SELECT status, failure, result_appointment_id FROM assistant_actions WHERE id = $1', [ref]))[0];
  const publicSlot = async (doctor: string, date: string, startTime: string) => ((await http().get(`/api/doctors/${doctor}/slots?date=${date}`).expect(200)).body.slots as { startTime: string; status: string }[]).find((s) => s.startTime === startTime)!;
  const stream = (doctor: string, date: string, start: string, end: string, capacity: number | null) =>
    db.query(
      `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity, slot_duration_minutes) VALUES ($1, 'ONE_TIME', $2, $3, $4, 'STREAM', $5, 30)`,
      [doctor, date, start, end, capacity],
    );
  const newDoctor = async (name: string, intervalMinutes: number | null) => {
    const userId = (await db.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', 'DOCTOR') RETURNING id", [name, `${randomUUID()}@test.local`])).rows[0].id as string;
    const [{ id: spec }] = await rows<{ id: string }>('SELECT id FROM specialties LIMIT 1');
    const [{ id: clinic }] = await rows<{ id: string }>('SELECT id FROM clinics LIMIT 1');
    return (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, slot_interval_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, $4, 20, 0) RETURNING id', [userId, clinic, spec, intervalMinutes])).rows[0].id as string;
  };
  /** Makes the next call of a real service method do its work and then fail, as if the connection dropped right after the commit. */
  const dropAfterCommit = <K extends 'book' | 'reschedule' | 'cancel'>(method: K) => {
    const target = svc().appointments;
    const real = target[method].bind(target);
    return vi.spyOn(target, method).mockImplementation(async (...args: unknown[]) => {
      await real(...args);
      throw new Error('connection lost');
    });
  };
  /** Makes the next call fail BEFORE it does anything, as if the process died right after the claim. */
  const dropBeforeWork = <K extends 'book' | 'reschedule' | 'cancel'>(method: K) =>
    vi.spyOn(svc().appointments, method).mockImplementation(async () => {
      throw new Error('connection lost');
    });

  afterEach(() => vi.restoreAllMocks());

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('rescheduling into a slot the appointment itself makes look full', () => {
    it('allows moving into an overlapping slot, because the old time is released first (and the public list still shows it taken)', async () => {
      const doctor = await newDoctor('Dr. Overlap', 15);
      await stream(doctor, day(3), '09:00', '11:00', null);
      const mine = (await book(0, doctor, day(3), '09:00').expect(201)).body;
      expect((await publicSlot(doctor, day(3), '09:15')).status).toBe('BOOKED'); // 09:15-09:45 overlaps the patient's own 09:00-09:30

      const { card, outputs } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '09:15' });
      expect(outputs[0]).toMatchObject({ prepared: true });
      expect(card!.lines[2].value).toContain('9:15 AM');
      expect((await appointments()).map((a) => [a.start_time, a.status])).toEqual([['09:00:00', 'CONFIRMED']]); // still untouched
      const done = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(done.message).toMatch(/^Moved:.*9:15 AM/);
      expect((await appointments()).map((a) => [a.start_time, a.status])).toEqual([['09:00:00', 'CANCELLED'], ['09:15:00', 'CONFIRMED']]);
    });

    it('allows moving inside a session that is at its booking cap only because of the appointment being moved', async () => {
      await stream(freeDoctor, day(3), '09:00', '11:00', 2);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      await book(1, freeDoctor, day(3), '09:30').expect(201);
      expect((await publicSlot(freeDoctor, day(3), '10:00')).status).toBe('FULL'); // 2 of 2 booked, one of them is the patient's own
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      expect(card).not.toBeNull();
      await confirm(patientTokens[0], card!.ref).expect(200);
      expect((await appointments("status = 'CONFIRMED'")).map((a) => a.start_time).sort((x, y) => x.localeCompare(y))).toEqual(['09:30:00', '10:00:00']);
    });

    it('still refuses a target that is genuinely taken: a full slot, an overlapping neighbour, and a session that is full without the patient', async () => {
      // a slot taken by someone else
      await session(freeDoctor, day(3), 1);
      const a = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      await book(1, freeDoctor, day(3), '10:00').expect(201);
      const full = await prepare(0, 'prepare_reschedule', { appointmentId: a.id, date: day(3), startTime: '10:00' });
      expect(full.card).toBeNull();
      expect(full.outputs[0].error).toMatch(/not open right now/);
      // an overlapping neighbour
      const doctor = await newDoctor('Dr. Overlap', 15);
      await stream(doctor, day(4), '09:00', '11:00', null);
      const b = (await book(2, doctor, day(4), '09:00').expect(201)).body;
      await book(3, doctor, day(4), '10:00').expect(201); // 10:00-10:30
      expect((await prepare(2, 'prepare_reschedule', { appointmentId: b.id, date: day(4), startTime: '09:45' })).card).toBeNull(); // 09:45-10:15 clashes with 10:00
      expect((await prepare(2, 'prepare_reschedule', { appointmentId: b.id, date: day(4), startTime: '09:30' })).card).not.toBeNull(); // 09:30-10:00 touches but does not clash
      // a session that is full of OTHER people's bookings
      await stream(freeDoctor, day(5), '09:00', '11:00', 2);
      await book(1, freeDoctor, day(5), '09:00').expect(201);
      await book(3, freeDoctor, day(5), '09:30').expect(201);
      const c = (await book(4, freeDoctor, day(3), '10:30').expect(201)).body;
      const sessionFull = await prepare(4, 'prepare_reschedule', { appointmentId: c.id, date: day(5), startTime: '10:00' });
      expect(sessionFull.card).toBeNull();
      expect(await rows('SELECT 1 FROM assistant_actions WHERE kind = \'RESCHEDULE\' AND user_id = $1', [patientIds[4]])).toEqual([]);
    });

    it('checks again at confirmation: a place taken meanwhile is refused, and the original stays exactly as it was', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      await book(1, freeDoctor, day(3), '10:00').expect(201);
      await confirm(patientTokens[0], card!.ref).expect(409);
      expect(await rows('SELECT status::text AS status, start_time::text AS t, cancel_reason FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CONFIRMED', t: '09:00:00', cancel_reason: null }]);
      expect(await appointments()).toHaveLength(2);
    });

    it('never lets a booking and a move race into one place: whoever loses, capacity holds and the mover keeps the original', async () => {
      for (const target of ['10:00', '10:30', '11:00']) {
        await db.query('DELETE FROM assistant_actions; DELETE FROM notifications; DELETE FROM appointments; DELETE FROM availability');
        await session(freeDoctor, day(3), 1, '09:00', '12:00');
        const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
        const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: target });
        const [move, other] = await Promise.all([confirm(patientTokens[0], card!.ref), book(1, freeDoctor, day(3), target)]);
        const holders = await appointments(`status IN ('PENDING', 'CONFIRMED') AND start_time = '${target}'`);
        expect(holders).toHaveLength(1); // one place, one holder, never two
        expect([move.status === 200, other.status === 201].filter(Boolean)).toHaveLength(1); // exactly one of them took the place
        if (move.status === 200) expect(other.status).toBe(409);
        else {
          expect([400, 409]).toContain(move.status);
          expect(await rows('SELECT status::text AS status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CONFIRMED' }]); // the loser keeps the original
        }
        expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time HAVING count(*) > max(slot_capacity)")).toEqual([]);
      }
    });

    it('rolls everything back when the move fails part-way: the original is unchanged and no new appointment is left behind', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      vi.spyOn(app.get(NotificationsService), 'appointmentRescheduled').mockRejectedValue(new Error('mail queue is down')); // fails after the new row was written, inside the transaction
      const failed = await confirm(patientTokens[0], card!.ref);
      expect(failed.status).toBe(502);
      expect(await rows('SELECT status::text AS status, start_time::text AS t FROM appointments')).toEqual([{ status: 'CONFIRMED', t: '09:00:00' }]); // nothing half-done
      expect(await rows('SELECT 1 FROM payments')).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('recovering an interrupted confirmation', () => {
    it('a crash right after the claim, before any work: nothing happened, and the records say so once the run could not still be going', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      const before = dropBeforeWork('book');
      const first = await confirm(patientTokens[0], card!.ref);
      expect(first.status).toBe(502);
      expect(first.body.code).toBe('ACTION_UNCERTAIN');
      expect(first.body.message).toMatch(/Nothing has been repeated/);
      expect(await row(card!.ref)).toMatchObject({ status: 'CONFIRMING' }); // an unknown outcome is not recorded as a failure
      // Too soon to be sure: it may still be running.
      expect((await status(patientTokens[0], card!.ref).expect(200)).body).toMatchObject({ state: 'IN_PROGRESS' });
      expect(await row(card!.ref)).toMatchObject({ status: 'CONFIRMING' });
      await age(card!.ref, 300);
      const settled = (await status(patientTokens[0], card!.ref).expect(200)).body;
      expect(settled).toMatchObject({ state: 'NOT_APPLIED' });
      expect(settled.message).toMatch(/Nothing was changed and nothing was repeated/);
      expect(await row(card!.ref)).toMatchObject({ status: 'FAILED', failure: expect.stringMatching(/^Recovered after an interruption/) });
      expect(await appointments()).toEqual([]);
      expect(before).toHaveBeenCalledTimes(1); // never retried
      await confirm(patientTokens[0], card!.ref).expect(409); // single-use, still
      expect(before).toHaveBeenCalledTimes(1);
    });

    it('a crash after the booking committed: found in the records, reported as done at once, not repeated, and one appointment only', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      const spy = dropAfterCommit('book');
      const res = await confirm(patientTokens[0], card!.ref).expect(200);
      expect(res.body).toMatchObject({ kind: 'BOOK', outcome: 'DONE', message: expect.stringMatching(/^It went through even though the connection was interrupted\. Booked: Dr\. Free/) });
      expect(await appointments()).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await row(card!.ref)).toMatchObject({ status: 'DONE', result_appointment_id: res.body.appointment.id });
      await confirm(patientTokens[0], card!.ref).expect(409);
      expect(await appointments()).toHaveLength(1);
    });

    it('the booking succeeded but recording it failed: the patient still gets the true result, and the stuck row is settled from the records', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      const repo = svc().actions;
      const realUpdate = repo.update.bind(repo);
      vi.spyOn(repo as unknown as Record<string, (...a: unknown[]) => unknown>, 'update').mockImplementation(async (...args: unknown[]) => {
        if ((args[1] as { status?: string }).status === 'DONE') throw new Error('database blip');
        return realUpdate(...args);
      });
      const res = await confirm(patientTokens[0], card!.ref).expect(200);
      expect(res.body.message).toMatch(/^Booked: Dr\. Free/); // no false "failed", no false "uncertain"
      expect(await row(card!.ref)).toMatchObject({ status: 'CONFIRMING' });
      vi.restoreAllMocks();
      const later = (await status(patientTokens[0], card!.ref).expect(200)).body;
      expect(later).toMatchObject({ state: 'DONE', appointment: { id: res.body.appointment.id } });
      expect(await row(card!.ref)).toMatchObject({ status: 'DONE', result_appointment_id: res.body.appointment.id });
      expect(await appointments()).toHaveLength(1);
    });

    it('the service said no but recording the failure failed: the patient still sees the real reason, and the records later agree', async () => {
      await session(freeDoctor, day(3), 1);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      await book(1, freeDoctor, day(3), '09:00').expect(201);
      const repo = svc().actions;
      const realUpdate = repo.update.bind(repo);
      vi.spyOn(repo as unknown as Record<string, (...a: unknown[]) => unknown>, 'update').mockImplementation(async (...args: unknown[]) => {
        if ((args[1] as { status?: string }).status === 'FAILED') throw new Error('database blip');
        return realUpdate(...args);
      });
      const refused = await confirm(patientTokens[0], card!.ref).expect(409);
      expect(refused.body.message).toMatch(/just been booked|full/i);
      vi.restoreAllMocks();
      expect(await row(card!.ref)).toMatchObject({ status: 'CONFIRMING' });
      await age(card!.ref, 300);
      expect((await status(patientTokens[0], card!.ref).expect(200)).body).toMatchObject({ state: 'NOT_APPLIED' });
      expect(await appointments()).toHaveLength(1); // only the other patient's
    });

    it('a sweep settles interrupted actions in both directions, never runs a booking, and leaves running ones alone', async () => {
      await session(freeDoctor, day(3), 2);
      const lost = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      const made = await prepare(1, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:30' });
      const running = await prepare(2, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '10:00' });
      dropBeforeWork('book');
      await confirm(patientTokens[0], lost.card!.ref).expect(502);
      vi.restoreAllMocks();
      dropAfterCommit('book');
      await confirm(patientTokens[1], made.card!.ref).expect(200); // recovered at once, so not stuck
      vi.restoreAllMocks();
      dropBeforeWork('book');
      await confirm(patientTokens[2], running.card!.ref).expect(502);
      vi.restoreAllMocks();
      const booked = vi.spyOn(svc().appointments, 'book');
      await age(lost.card!.ref, 300); // old enough to judge; the third is recent and may still be running
      expect(await app.get(AssistantActionsService).reconcileStuck()).toBe(1);
      expect(booked).not.toHaveBeenCalled(); // reconcile-only
      expect(await row(lost.card!.ref)).toMatchObject({ status: 'FAILED', failure: expect.stringMatching(/^Recovered/) });
      expect(await row(running.card!.ref)).toMatchObject({ status: 'CONFIRMING' });
      expect(await appointments()).toHaveLength(1);
    });

    it('a move interrupted after it committed is found by its rescheduled-from link and is not repeated or duplicated', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      const spy = dropAfterCommit('reschedule');
      const res = await confirm(patientTokens[0], card!.ref).expect(200);
      expect(res.body.message).toMatch(/^It went through even though the connection was interrupted\. Moved:/);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await appointments()).map((a) => [a.start_time, a.status])).toEqual([['09:00:00', 'CANCELLED'], ['10:00:00', 'CONFIRMED']]);
    });

    it('a move interrupted before it committed leaves the original untouched, and the records show it was not moved', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      dropBeforeWork('reschedule');
      await confirm(patientTokens[0], card!.ref).expect(502);
      await age(card!.ref, 300);
      expect((await status(patientTokens[0], card!.ref).expect(200)).body).toMatchObject({ state: 'NOT_APPLIED', message: expect.stringMatching(/unchanged/) });
      expect((await appointments()).map((a) => [a.start_time, a.status])).toEqual([['09:00:00', 'CONFIRMED']]);
    });

    it('a cancellation interrupted after it committed is found, not repeated, and refunds exactly once', async () => {
      await session(paidDoctor, day(3), 1);
      const id = await paidAppointment(0);
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: id });
      const spy = dropAfterCommit('cancel');
      const res = await confirm(patientTokens[0], card!.ref).expect(200);
      expect(res.body.message).toMatch(/^It went through even though the connection was interrupted\. Cancelled:/);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await appointments())[0].status).toBe('CANCELLED');
      expect(await rows('SELECT 1 FROM refunds')).toHaveLength(1);
      await confirm(patientTokens[0], card!.ref).expect(409);
      expect(await rows('SELECT 1 FROM refunds')).toHaveLength(1);
    });

    it('says UNCERTAIN, and repeats nothing, when the records cannot settle it (cancelled just then, but by someone else)', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: mine.id });
      dropBeforeWork('cancel');
      await confirm(patientTokens[0], card!.ref).expect(502);
      vi.restoreAllMocks();
      await age(card!.ref, 600);
      // The doctor cancels the appointment ten seconds after the claim: inside the window in which this request's own change could have landed.
      await db.query("UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'Doctor unavailable', cancelled_at = (SELECT decided_at + interval '10 seconds' FROM assistant_actions WHERE id = $3), cancelled_by_user_id = (SELECT user_id FROM doctors WHERE id = $1) WHERE id = $2", [freeDoctor, mine.id, card!.ref]);
      const unsure = (await status(patientTokens[0], card!.ref).expect(200)).body;
      expect(unsure).toMatchObject({ state: 'UNCERTAIN', reconcileWith: 'My Appointments' });
      expect(unsure.message).toMatch(/not by you/);
      expect(await app.get(AssistantActionsService).reconcileStuck()).toBe(0); // not settled by guesswork
      expect(await row(card!.ref)).toMatchObject({ status: 'CONFIRMING' });
      const again = await confirm(patientTokens[0], card!.ref).expect(409);
      expect(again.body.code).toBe('ACTION_UNCERTAIN');
    });

    it('judges a cancellation despite the application and database clocks disagreeing by a few seconds', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: mine.id });
      // The real service cancels (stamping cancelled_at from the application clock), then the connection drops. The database clock is 8 seconds
      // ahead of the application's, so the claim time lands AFTER the cancellation's own timestamp.
      const target = svc().appointments;
      const real = target.cancel.bind(target);
      vi.spyOn(target, 'cancel').mockImplementation(async (...args: unknown[]) => {
        await real(...args);
        await db.query("UPDATE assistant_actions SET decided_at = decided_at + interval '8 seconds' WHERE id = $1", [card!.ref]);
        throw new Error('connection lost');
      });
      const res = await confirm(patientTokens[0], card!.ref);
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/^It went through even though the connection was interrupted\. Cancelled:/);
    });

    it('does not mistake a LATER booking of the same slot for the interrupted one', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      dropBeforeWork('book');
      await confirm(patientTokens[0], card!.ref).expect(502);
      vi.restoreAllMocks();
      await age(card!.ref, 600); // the interrupted run's window closed ten minutes ago
      expect((await status(patientTokens[0], card!.ref).expect(200)).body.state).toBe('NOT_APPLIED');
      const again = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      await confirm(patientTokens[0], again.card!.ref).expect(200); // a fresh, explicit confirmation books it
      expect((await status(patientTokens[0], card!.ref).expect(200)).body.state).toBe('NOT_APPLIED'); // the old record is not rewritten by it
      expect(await appointments()).toHaveLength(1);
    });

    it('finds a slow commit that lands after "not applied" was concluded, and corrects the record', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      dropBeforeWork('book');
      await confirm(patientTokens[0], card!.ref).expect(502);
      vi.restoreAllMocks();
      await age(card!.ref, 130);
      expect((await status(patientTokens[0], card!.ref).expect(200)).body.state).toBe('NOT_APPLIED');
      // The original run, slow rather than dead, commits within its window after all.
      await db.query(
        "INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity, created_at) VALUES ((SELECT id FROM patients WHERE user_id = $1), $2, $1, $3, '09:00', '09:30', 'CONFIRMED', 1, 2, now() - interval '20 seconds')",
        [patientIds[0], freeDoctor, day(3)],
      );
      const corrected = (await status(patientTokens[0], card!.ref).expect(200)).body;
      expect(corrected).toMatchObject({ state: 'DONE', message: expect.stringMatching(/went through/) });
      expect(await row(card!.ref)).toMatchObject({ status: 'DONE' });
    });

    it('settles safely when asked many times at once', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      dropAfterCommit('book');
      vi.spyOn(svc().actions as unknown as Record<string, (...a: unknown[]) => unknown>, 'update').mockImplementation(async () => {
        throw new Error('database blip');
      });
      await confirm(patientTokens[0], card!.ref).expect(200);
      vi.restoreAllMocks();
      const results = await Promise.all([1, 2, 3, 4].map(() => status(patientTokens[0], card!.ref)));
      expect(results.every((res) => res.status === 200 && res.body.state === 'DONE')).toBe(true);
      expect(await appointments()).toHaveLength(1);
      expect(await row(card!.ref)).toMatchObject({ status: 'DONE' });
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('the status of an action', () => {
    it('reports prepared, expired, dismissed, done and failed accurately, and only to the patient it belongs to', async () => {
      await session(freeDoctor, day(3), 1);
      const a = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      expect((await status(patientTokens[0], a.card!.ref).expect(200)).body).toMatchObject({ state: 'PREPARED', kind: 'BOOK' });
      await status(patientTokens[1], a.card!.ref).expect(404); // not yours
      await status(doctorToken, a.card!.ref).expect(403);
      await http().get(`/api/assistant/actions/${a.card!.ref}`).expect(401);
      await http().get('/api/assistant/actions/not-a-uuid').set(as(patientTokens[0])).expect(400);
      await db.query("UPDATE assistant_actions SET expires_at = now() - interval '1 second' WHERE id = $1", [a.card!.ref]);
      expect((await status(patientTokens[0], a.card!.ref).expect(200)).body.state).toBe('EXPIRED');

      const b = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      await dismiss(patientTokens[0], b.card!.ref).expect(200);
      expect((await status(patientTokens[0], b.card!.ref).expect(200)).body.state).toBe('DISMISSED');

      const c = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      const d = await prepare(1, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' }); // both were shown the same open place
      const done = (await confirm(patientTokens[0], c.card!.ref).expect(200)).body;
      expect((await status(patientTokens[0], c.card!.ref).expect(200)).body).toMatchObject({ state: 'DONE', message: expect.stringMatching(/^Booked:/), appointment: { id: done.appointment.id } });

      await confirm(patientTokens[1], d.card!.ref).expect(409); // the place is taken
      expect((await status(patientTokens[1], d.card!.ref).expect(200)).body).toMatchObject({ state: 'FAILED', message: expect.stringMatching(/Nothing was changed/) });
    });
  });
});
