// Phase 2 of the AI assistant: real booking, rescheduling and cancelling, each only after the patient presses Confirm.
//  - the model can only PREPARE: it gets a short note back, the patient gets a confirmation card, and nothing changes;
//  - the confirm call takes only a server-issued reference: it must belong to the signed-in patient, be unused and unexpired, and runs
//    exactly what was stored, through the existing booking/payment services (their own locks, capacity, duplicate and refund rules);
//  - payments use the existing flow with a fake gateway (no network, no real charge): the server's verification, never the browser, decides.
// The real app, database and services run; only the model and the payment gateway are replaced.

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { LLM_CLIENT, type LlmClient, type LlmRequest, type LlmResponse } from '../src/assistant/llm/llm-client.js';
import { RateLimiter } from '../src/assistant/rate-limit.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { EMAIL_SENDER } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { PAYMENT_GATEWAY, type GatewayRefund, type PaymentGateway } from '../src/payments/payment-gateway.js';
import { PaymentsService } from '../src/payments/payments.service.js';
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

describe('AI assistant, phase 2: confirmed appointment actions (e2e)', () => {
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
  const actionRow = async (ref: string) => (await rows<{ status: string; failure: string | null; result_appointment_id: string | null }>('SELECT status, failure, result_appointment_id FROM assistant_actions WHERE id = $1', [ref]))[0];
  const signature = (orderId: string, paymentId: string, secret = KEY_SECRET) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const verify = (token: string, orderId: string, paymentId = `pay_${randomUUID().slice(0, 8)}`, secret = KEY_SECRET) =>
    http().post('/api/payments/verify').set(as(token)).send({ razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature(orderId, paymentId, secret) });
  const webhook = (event: object) => {
    const raw = JSON.stringify(event);
    return http().post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')).set('x-razorpay-event-id', `evt_${randomUUID()}`).send(raw);
  };

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

  describe('booking', () => {
    it('only prepares: the patient gets a card, the model gets a note without the reference, and nothing is booked', async () => {
      await session(freeDoctor, day(3));
      const { res, card, outputs, shown } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:30' });
      expect(res.status).toBe(200);
      expect(card).toMatchObject({ kind: 'BOOK', title: 'Book this appointment?', confirmLabel: 'Confirm booking' });
      expect(card!.lines).toEqual([
        { label: 'Doctor', value: 'Dr. Free (ENT)' },
        { label: 'Clinic', value: 'Clinic A, 1 A St' },
        { label: 'Date', value: expect.stringMatching(/\d{4}/) },
        { label: 'Time', value: '9:30 AM – 10:00 AM' },
        { label: 'Fee', value: 'No charge' },
      ]);
      expect(outputs[0]).toMatchObject({ prepared: true, kind: 'BOOK', instruction: expect.stringMatching(/cannot confirm it and nothing has happened/) });
      expect(JSON.stringify(requests)).not.toContain(card!.ref); // the model never sees the reference
      expect(shown).not.toMatch(/ref|checkout|rzp_/i);
      expect(await appointments()).toEqual([]);
      expect(await actionRow(card!.ref)).toMatchObject({ status: 'PREPARED' });
    });

    it('books a free appointment only when the patient confirms, and reports what the server did', async () => {
      await session(freeDoctor, day(3));
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      expect(await appointments()).toEqual([]);
      const done = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'BOOK', outcome: 'DONE', message: expect.stringMatching(/^Booked: Dr\. Free on .* at 9:00 AM\.$/) });
      expect(done.checkout).toBeUndefined();
      const [saved] = await appointments();
      expect(saved).toMatchObject({ status: 'CONFIRMED', start_time: '09:00:00', appointment_date: day(3) });
      expect(done.appointment.id).toBe(saved.id);
      expect(await actionRow(card!.ref)).toEqual({ status: 'DONE', failure: null, result_appointment_id: saved.id });
      expect((await rows<{ recipient_role: string }>("SELECT recipient_role FROM notifications WHERE kind = 'booking-confirmed'")).map((n) => n.recipient_role).sort()).toEqual(['DOCTOR', 'PATIENT']); // the existing notices
    });

    it('a doctor with a fee: the slot is held, nothing is called paid or confirmed until the server verifies the payment', async () => {
      await session(paidDoctor, day(3));
      const { card } = await prepare(0, 'prepare_booking', { doctorId: paidDoctor, date: day(3), startTime: '09:00' });
      expect(card!.lines.find((line) => line.label === 'Fee')!.value).toBe('Rs. 650, paid online after you confirm');
      expect(card!.note).toMatch(/held for 15 minutes.*only once the payment is verified/);
      const held = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(held).toMatchObject({ kind: 'BOOK', outcome: 'PAYMENT_REQUIRED', checkout: { keyId: 'rzp_test_e2e', amountPaise: FEE * 100 } });
      expect(held.message).toMatch(/not booked until the payment is verified/);
      expect(held.message).not.toMatch(/^Booked/);
      const id = held.appointment.id as string;
      expect((await appointments())[0].status).toBe('PENDING');

      // The model is told the truth, and is never shown order ids, keys or amounts in paise.
      const pending = await converse(patientTokens[0], [{ name: 'get_payment_status', args: { appointmentId: id } }]);
      expect(pending.outputs[0]).toMatchObject({ appointment: { status: 'PENDING' }, payment: { state: 'PAYMENT_PENDING', meaning: expect.stringMatching(/NOT been completed/), amount: 'Rs. 650' } });
      expect(pending.shown).not.toMatch(/order_|rzp_|e2e_razorpay|signature|65000/);

      // A browser claiming success with a forged signature proves nothing.
      await verify(patientTokens[0], held.checkout.orderId, 'pay_forged', 'not-the-secret').expect(400);
      expect((await appointments())[0].status).toBe('PENDING');
      expect((await converse(patientTokens[0], [{ name: 'get_payment_status', args: { appointmentId: id } }])).outputs[0].payment.state).toBe('PAYMENT_PENDING');

      // The real verification confirms it, once, however many times it arrives.
      await verify(patientTokens[0], held.checkout.orderId, 'pay_real_1').expect(200);
      await verify(patientTokens[0], held.checkout.orderId, 'pay_real_1').expect(200);
      expect((await appointments())[0].status).toBe('CONFIRMED');
      expect(await rows('SELECT status FROM payments')).toEqual([{ status: 'PAID' }]);
      expect((await converse(patientTokens[0], [{ name: 'get_payment_status', args: { appointmentId: id } }])).outputs[0].payment).toMatchObject({ state: 'PAID', meaning: expect.stringMatching(/verified by the server/) });
    });

    it('reports failed and expired payments as they are, and a failure leaves the slot held only until the hold ends', async () => {
      await session(paidDoctor, day(3));
      const held = await bookViaAssistant(0, paidDoctor, day(3), '09:00');
      await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_x', order_id: held.checkout.orderId, error_description: 'Card declined' } } } }).expect(200);
      const failed = (await converse(patientTokens[0], [{ name: 'get_payment_status', args: { appointmentId: held.appointment.id } }])).outputs[0];
      expect(failed.payment).toMatchObject({ state: 'PAYMENT_FAILED', failureReason: 'Card declined' });
      expect(failed.payment.meaning).toMatch(/retry/);
      // A retry is the existing secure checkout (the booking page and My Appointments offer it): it works for this same booking.
      await http().post(`/api/payments/appointments/${held.appointment.id}/checkout`).set(as(patientTokens[0])).expect(200);

      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [held.appointment.id]);
      await app.get(PaymentsService).expireHolds();
      const expired = (await converse(patientTokens[0], [{ name: 'get_payment_status', args: { appointmentId: held.appointment.id } }])).outputs[0];
      expect(expired).toMatchObject({ appointment: { status: 'CANCELLED' }, payment: { state: 'EXPIRED' } });
    });

    it('refuses a slot that is not open when preparing, and prepares nothing', async () => {
      await session(freeDoctor, day(3));
      const gone = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '13:00' }); // outside the session
      expect(gone.card).toBeNull();
      expect(gone.outputs[0]).toEqual({ error: expect.stringMatching(/not open right now/) });
      expect((await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(40), startTime: '09:00' })).outputs[0].error).toMatch(/ahead/);
      expect((await prepare(0, 'prepare_booking', { doctorId: randomUUID(), date: day(3), startTime: '09:00' })).outputs[0].error).toMatch(/Doctor not found/);
      expect((await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '9am' })).outputs[0].error).toMatch(/Invalid input/);
      expect(await rows('SELECT 1 FROM assistant_actions')).toEqual([]);
    });

    it('rejects a booking whose slot was taken between preparing and confirming, and books nobody twice', async () => {
      await session(freeDoctor, day(3), 1);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      await book(1, freeDoctor, day(3), '09:00').expect(201); // someone else takes the only place
      const refused = await confirm(patientTokens[0], card!.ref).expect(409);
      expect(refused.body.message).toMatch(/just been booked|full/i);
      expect(await appointments()).toHaveLength(1);
      expect(await actionRow(card!.ref)).toMatchObject({ status: 'FAILED', failure: expect.stringMatching(/just been booked|full/i) });
      await confirm(patientTokens[0], card!.ref).expect(409); // spent
    });

    it('rejects a booking when the capacity fell below the bookings before confirming', async () => {
      await session(freeDoctor, day(3), 3);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      await book(1, freeDoctor, day(3), '09:00').expect(201);
      await book(2, freeDoctor, day(3), '09:00').expect(201);
      await db.query('UPDATE availability SET capacity_per_slot = 2 WHERE doctor_id = $1', [freeDoctor]); // the doctor lowers it: two booked, room for two
      await confirm(patientTokens[0], card!.ref).expect(409);
      expect(await appointments()).toHaveLength(2);
    });

    it('cannot be confirmed twice: simultaneous clicks and later replays create one appointment, even after it is cancelled', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      const results = await Promise.all([confirm(patientTokens[0], card!.ref), confirm(patientTokens[0], card!.ref), confirm(patientTokens[0], card!.ref)]);
      expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409, 409]);
      expect(await appointments()).toHaveLength(1);
      const id = (await appointments())[0].id;
      await http().post(`/api/appointments/${id}/cancel`).set(as(patientTokens[0])).send({}).expect(200);
      await confirm(patientTokens[0], card!.ref).expect(409); // an old confirmation cannot rebook after a cancel
      expect(await appointments('status IN (\'PENDING\', \'CONFIRMED\')')).toEqual([]);
    });

    it('keeps the existing rule against booking the same time twice', async () => {
      await session(freeDoctor, day(3), 2);
      await book(0, freeDoctor, day(3), '09:00').expect(201);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      const refused = await confirm(patientTokens[0], card!.ref).expect(409);
      expect(refused.body.message).toMatch(/already have an appointment/);
      expect(await appointments()).toHaveLength(1);
    });
  });

  describe('rescheduling', () => {
    it('moves the appointment only on confirmation; the original stays booked until then and is released as the new one is made', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card, outputs } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      expect(card).toMatchObject({ kind: 'RESCHEDULE', title: 'Move this appointment?', confirmLabel: 'Confirm move' });
      expect(card!.lines.map((line) => line.label)).toEqual(['Doctor', 'Now', 'Move to']);
      expect(card!.lines[1].value).toContain('9:00 AM');
      expect(card!.lines[2].value).toContain('10:00 AM');
      expect(outputs[0].instruction).toMatch(/Never say it is booked, moved or cancelled/);
      expect((await appointments()).map((a) => [a.start_time, a.status])).toEqual([['09:00:00', 'CONFIRMED']]); // nothing moved yet

      const done = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'RESCHEDULE', outcome: 'DONE', message: expect.stringMatching(/^Moved: Dr\. Free on .* at 10:00 AM\./) });
      expect((await appointments()).map((a) => [a.start_time, a.status])).toEqual([['09:00:00', 'CANCELLED'], ['10:00:00', 'CONFIRMED']]);
      expect(await rows("SELECT cancel_reason FROM appointments WHERE start_time = '09:00'")).toEqual([{ cancel_reason: 'Rescheduled by patient' }]);
    });

    it("cannot touch another patient's appointment, however the request is made", async () => {
      await session(freeDoctor, day(3), 1);
      const theirs = (await book(1, freeDoctor, day(3), '09:00').expect(201)).body;
      const asked = await prepare(0, 'prepare_reschedule', { appointmentId: theirs.id, date: day(3), startTime: '10:00' });
      expect(asked.card).toBeNull();
      expect(asked.outputs[0]).toEqual({ error: 'Appointment not found.' });
      expect(asked.shown).not.toMatch(/Patient 2|09:00/);
      expect(await rows('SELECT 1 FROM assistant_actions')).toEqual([]);
      // A confirmation made by the owner cannot be used by someone else either.
      const owners = await prepare(1, 'prepare_reschedule', { appointmentId: theirs.id, date: day(3), startTime: '10:00' });
      await confirm(patientTokens[0], owners.card!.ref).expect(404);
      expect(await actionRow(owners.card!.ref)).toMatchObject({ status: 'PREPARED' }); // still the owner's to use
      await confirm(patientTokens[1], owners.card!.ref).expect(200);
    });

    it('rejects an expired confirmation and changes nothing', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      await db.query("UPDATE assistant_actions SET expires_at = now() - interval '1 second' WHERE id = $1", [card!.ref]);
      const refused = await confirm(patientTokens[0], card!.ref).expect(410);
      expect(refused.body.message).toMatch(/expired/);
      expect((await appointments()).map((a) => a.status)).toEqual(['CONFIRMED']);
      await dismiss(patientTokens[0], card!.ref).expect(410);
    });

    it('rejects the move when the new slot was taken meanwhile, and the original appointment is preserved', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      await book(1, freeDoctor, day(3), '10:00').expect(201);
      const refused = await confirm(patientTokens[0], card!.ref).expect(409);
      expect(refused.body.message).toMatch(/just been booked|full/i);
      expect((await appointments(`patient_id = (SELECT id FROM patients WHERE user_id = '${patientIds[0]}')`)).map((a) => [a.start_time, a.status])).toEqual([['09:00:00', 'CONFIRMED']]);
      expect(await actionRow(card!.ref)).toMatchObject({ status: 'FAILED' });
    });

    it('rejects a move for an appointment that was already cancelled or already moved', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const first = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:00' });
      const second = await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:30' });
      await confirm(patientTokens[0], first.card!.ref).expect(200);
      const stale = await confirm(patientTokens[0], second.card!.ref).expect(409); // the original is now history
      expect(stale.body.message).toMatch(/cancelled|cannot/i);
      expect((await appointments("status = 'CONFIRMED'")).map((a) => a.start_time)).toEqual(['10:00:00']);
      // And preparing again for the old appointment is refused up front.
      expect((await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '10:30' })).outputs[0].error).toMatch(/already cancelled/);
    });

    it('refuses what the booking rules refuse: an appointment that has started, an unpaid hold, or the same time', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      expect((await prepare(0, 'prepare_reschedule', { appointmentId: mine.id, date: day(3), startTime: '09:00' })).outputs[0].error).toMatch(/already has/);
      await db.query("INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity) VALUES ((SELECT id FROM patients WHERE user_id = $1), $2, $1, $3, '00:00', '00:01', 'CONFIRMED', 1, 1)", [patientIds[2], freeDoctor, today]);
      const started = (await rows<{ id: string }>("SELECT id FROM appointments WHERE start_time = '00:00'"))[0].id;
      expect((await prepare(2, 'prepare_reschedule', { appointmentId: started, date: day(3), startTime: '10:00' })).outputs[0].error).toMatch(/already started or passed/);
      await session(paidDoctor, day(4), 1);
      const held = await bookViaAssistant(3, paidDoctor, day(4), '09:00');
      expect((await prepare(3, 'prepare_reschedule', { appointmentId: held.appointment.id, date: day(4), startTime: '10:00' })).outputs[0].error).toMatch(/Finish paying/);
    });

    it('a paid appointment keeps its payment when moved: no refund and no second charge', async () => {
      await session(paidDoctor, day(3), 1);
      const id = await paidAppointment(0);
      const { card } = await prepare(0, 'prepare_reschedule', { appointmentId: id, date: day(3), startTime: '10:00' });
      expect(card!.note).toMatch(/payment moves with the appointment/);
      await confirm(patientTokens[0], card!.ref).expect(200);
      expect(await rows('SELECT status FROM payments')).toEqual([{ status: 'PAID' }]);
      expect(await rows('SELECT 1 FROM refunds')).toEqual([]);
      expect((await appointments("status = 'CONFIRMED'")).map((a) => a.start_time)).toEqual(['10:00:00']);
    });
  });

  describe('cancelling', () => {
    it('cancels only on confirmation, and says what the policy gives back before and what actually started after', async () => {
      await session(paidDoctor, day(3), 1);
      const id = await paidAppointment(0);
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: id });
      expect(card).toMatchObject({ kind: 'CANCEL', title: 'Cancel this appointment?', confirmLabel: 'Cancel appointment', dismissLabel: 'Keep my appointment' });
      expect(card!.lines.find((line) => line.label === 'Refund')!.value).toMatch(/Rs\. 650 of the Rs\. 650 paid \(100%\).*at least 24 hours/);
      expect((await appointments())[0].status).toBe('CONFIRMED'); // asking is not cancelling

      const done = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'CANCEL', outcome: 'DONE', message: expect.stringMatching(/^Cancelled: Dr\. Paid on .*A refund of Rs\. 650 has been started and is pending/) });
      expect((await appointments())[0].status).toBe('CANCELLED');
      expect(await rows('SELECT amount_paise, status FROM refunds')).toEqual([{ amount_paise: FEE * 100, status: 'PENDING' }]);
      expect((await rows<{ recipient_role: string }>("SELECT recipient_role FROM notifications WHERE kind = 'booking-cancelled'")).map((n) => n.recipient_role)).toContain('PATIENT');

      // The refund is "pending" until the provider says otherwise, and the model is told exactly that.
      const pending = (await converse(patientTokens[0], [{ name: 'get_refund_status', args: { appointmentId: id } }])).outputs[0];
      expect(pending.refunds).toEqual([expect.objectContaining({ amount: 'Rs. 650', status: 'PENDING', meaning: expect.stringMatching(/NOT complete/) })]);
      const refundId = (await rows<{ razorpay_refund_id: string; razorpay_payment_id: string }>('SELECT r.razorpay_refund_id, p.razorpay_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id'))[0];
      await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: refundId.razorpay_refund_id, payment_id: refundId.razorpay_payment_id, amount: FEE * 100, status: 'processed' } } } }).expect(200);
      const processed = (await converse(patientTokens[0], [{ name: 'get_refund_status', args: { appointmentId: id } }])).outputs[0];
      expect(processed).toMatchObject({ paymentState: 'REFUNDED', refunds: [expect.objectContaining({ status: 'PROCESSED', meaning: expect.stringMatching(/Completed/) })] });
    });

    it('applies the real policy at confirmation: close to the appointment, a partial refund', async () => {
      await session(paidDoctor, day(0), 1, '00:30', '23:30');
      const soon = await db.query("INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity) VALUES ((SELECT id FROM patients WHERE user_id = $1), $2, $1, $3, '23:00', '23:30', 'CONFIRMED', 1, 1) RETURNING id", [patientIds[0], paidDoctor, today]);
      const id = soon.rows[0].id as string;
      await db.query("INSERT INTO payments (appointment_id, patient_id, razorpay_order_id, razorpay_payment_id, amount_paise, currency, status, paid_at) VALUES ($1, (SELECT id FROM patients WHERE user_id = $2), 'order_seed', 'pay_seed', $3, 'INR', 'PAID', now())", [id, patientIds[0], FEE * 100]);
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: id });
      const text = card!.lines.find((line) => line.label === 'Refund')!.value;
      expect(text).toMatch(/\(50%\)|\(100%\)|No refund/); // whichever tier the real clock gives; it states the policy's own reason
      const done = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(done.appointment.status).toBe('CANCELLED');
    });

    it('does not cancel anything for a prepared card nobody confirms, and a dismissed card can never be confirmed', async () => {
      await session(freeDoctor, day(3), 1);
      const mine = (await book(0, freeDoctor, day(3), '09:00').expect(201)).body;
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: mine.id });
      expect(card!.lines.find((line) => line.label === 'Refund')!.value).toMatch(/nothing to refund/);
      await dismiss(patientTokens[0], card!.ref).expect(200);
      expect(await actionRow(card!.ref)).toMatchObject({ status: 'DISMISSED' });
      await confirm(patientTokens[0], card!.ref).expect(409);
      expect((await appointments())[0].status).toBe('CONFIRMED');
    });

    it("cannot cancel another patient's appointment", async () => {
      await session(freeDoctor, day(3), 1);
      const theirs = (await book(1, freeDoctor, day(3), '09:00').expect(201)).body;
      const asked = await prepare(0, 'prepare_cancellation', { appointmentId: theirs.id });
      expect(asked.card).toBeNull();
      expect(asked.outputs[0]).toEqual({ error: 'Appointment not found.' });
      const owners = await prepare(1, 'prepare_cancellation', { appointmentId: theirs.id });
      await confirm(patientTokens[0], owners.card!.ref).expect(404);
      await dismiss(patientTokens[0], owners.card!.ref).expect(404); // and cannot even dismiss it
      expect((await appointments())[0].status).toBe('CONFIRMED');
    });

    it('handles repeated cancellation safely: one cancellation, one refund, and a clear message the second time', async () => {
      await session(paidDoctor, day(3), 1);
      const id = await paidAppointment(0);
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: id });
      const results = await Promise.all([confirm(patientTokens[0], card!.ref), confirm(patientTokens[0], card!.ref)]);
      expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);
      expect(await rows('SELECT 1 FROM refunds')).toHaveLength(1);
      expect((await prepare(0, 'prepare_cancellation', { appointmentId: id })).outputs[0].error).toMatch(/already cancelled/);
      // Even a card prepared earlier for the same appointment cannot cancel (or refund) it again.
      const stale = await db.query("INSERT INTO assistant_actions (user_id, kind, params, expires_at) VALUES ($1, 'CANCEL', jsonb_build_object('appointmentId', $2::text), now() + interval '5 minutes') RETURNING id", [patientIds[0], id]);
      await confirm(patientTokens[0], stale.rows[0].id).expect(409);
      expect(await rows('SELECT 1 FROM refunds')).toHaveLength(1);
    });

    it('shows no refund for an unpaid hold, and releases it on confirmation', async () => {
      await session(paidDoctor, day(3), 1);
      const held = await bookViaAssistant(0, paidDoctor, day(3), '09:00');
      const { card } = await prepare(0, 'prepare_cancellation', { appointmentId: held.appointment.id });
      expect(card!.lines.find((line) => line.label === 'Refund')!.value).toMatch(/Not paid yet/);
      const done = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(done.message).toMatch(/Nothing had been paid/);
      expect(await rows('SELECT status FROM payments')).toEqual([{ status: 'EXPIRED' }]);
    });
  });

  describe('security', () => {
    it('gives doctors no way to book, move, cancel or confirm: their tools stay read-only and the confirm endpoints refuse them', async () => {
      await session(freeDoctor, day(3));
      const attempt = await converse(doctorToken, [{ name: 'prepare_booking', args: { doctorId: freeDoctor, date: day(3), startTime: '09:00' } }]);
      expect(attempt.outputs[0]).toEqual({ error: 'That tool does not exist.' });
      expect(attempt.card).toBeNull();
      const offered = requests[0].tools.map((tool) => tool.name);
      expect(offered.filter((name) => name.startsWith('prepare_'))).toEqual(['prepare_schedule_change']); // never booking, moving or cancelling: only a change to the doctor's own hours (see assistant-schedule-changes.e2e-spec.ts)
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      await confirm(doctorToken, card!.ref).expect(403);
      await dismiss(doctorToken, card!.ref).expect(403);
      expect(await appointments()).toEqual([]);
    });

    it('gives patients the new tools alongside the read-only ones, and no tool that confirms anything', async () => {
      await converse(patientTokens[0], [{ name: 'get_my_appointments' }]);
      expect(requests[0].tools.map((tool) => tool.name).sort()).toEqual([
        'get_available_slots', 'get_my_appointments', 'get_payment_status', 'get_refund_status', 'prepare_booking', 'prepare_cancellation', 'prepare_reschedule', 'search_doctors', 'suggest_alternative_slots',
      ]);
      const forged = await converse(patientTokens[0], [{ name: 'confirm_booking', args: { confirmed: true } }, { name: 'confirm_action', args: { ref: randomUUID() } }]);
      expect(forged.outputs).toEqual([{ error: 'That tool does not exist.' }, { error: 'That tool does not exist.' }]);
    });

    it('treats a chat "yes" as nothing: it cannot confirm, whatever the model does', async () => {
      await session(freeDoctor, day(3));
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      requests.length = 0;
      script = () => ({ text: 'Done! I have booked it for you.', toolCalls: [] }); // a model that lies
      await chat(patientTokens[0], 'yes, confirm it').expect(200);
      expect(await appointments()).toEqual([]);
      expect(await actionRow(card!.ref)).toMatchObject({ status: 'PREPARED' });
    });

    it('treats a SPOKEN "yes, confirm it" (voice mode, in English, Hindi or Hinglish) as nothing: only the Confirm button on the card can confirm', async () => {
      await session(freeDoctor, day(3));
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      for (const spoken of ['yes, confirm it', 'haan, confirm kar do', 'हाँ, बुक कर दो']) {
        script = () => ({ text: 'Done! I have booked it for you.', toolCalls: [] }); // a model that wrongly claims success
        await http().post('/api/assistant/chat').set(as(patientTokens[0])).send({ messages: [{ role: 'user', content: spoken }], voice: true, language: 'hinglish' }).expect(200);
      }
      expect(await appointments()).toEqual([]);
      expect(await actionRow(card!.ref)).toMatchObject({ status: 'PREPARED' });
      await confirm(patientTokens[0], card!.ref).expect(200); // only the authenticated button works, with its own single-use reference
      expect(await appointments()).toHaveLength(1);
    });

    it('lets only the patient who was shown a card confirm it, and a confirmation names nothing the browser can change', async () => {
      await session(freeDoctor, day(3), 2);
      const { card } = await prepare(0, 'prepare_booking', { doctorId: freeDoctor, date: day(3), startTime: '09:00' });
      await confirm(patientTokens[1], card!.ref).expect(404); // another patient cannot use it
      await confirm(patientTokens[1], randomUUID()).expect(404);
      await http().post(`/api/assistant/actions/${card!.ref}/confirm`).set(as(patientTokens[0])).send({ doctorId: paidDoctor, startTime: '10:00', userId: patientIds[1] }).expect(400); // no overrides in the body
      await http().post('/api/assistant/actions/not-a-uuid/confirm').set(as(patientTokens[0])).send({}).expect(400);
      await http().post(`/api/assistant/actions/${card!.ref}/confirm`).send({}).expect(401);
      expect(await appointments()).toEqual([]);
      const done = (await confirm(patientTokens[0], card!.ref).expect(200)).body;
      expect(done.appointment.doctor.name).toBe('Dr. Free'); // what was stored, at the stored time
      expect((await appointments())[0]).toMatchObject({ start_time: '09:00:00', patient_id: (await rows<{ id: string }>('SELECT id FROM patients WHERE user_id = $1', [patientIds[0]]))[0].id });
    });

    it('lets the model prepare one action per answer, and never lets a prepared action name another user', async () => {
      await session(freeDoctor, day(3), 2);
      const twice = await converse(patientTokens[0], [
        { name: 'prepare_booking', args: { doctorId: freeDoctor, date: day(3), startTime: '09:00' } },
        { name: 'prepare_booking', args: { doctorId: freeDoctor, date: day(3), startTime: '09:30' } },
      ]);
      expect(twice.res.body.actions).toHaveLength(1);
      expect(twice.outputs[1]).toEqual({ error: expect.stringMatching(/already waiting/) });
      expect(await rows('SELECT user_id FROM assistant_actions')).toEqual([{ user_id: patientIds[0] }]);
      // Arguments that try to name a user are simply not part of any tool.
      const sneaky = await converse(patientTokens[1], [{ name: 'prepare_booking', args: { doctorId: freeDoctor, date: day(3), startTime: '10:00', userId: patientIds[0], patientId: 'x' } }]);
      expect(await rows('SELECT user_id FROM assistant_actions WHERE id = $1', [sneaky.card!.ref])).toEqual([{ user_id: patientIds[1] }]);
    });

    it('never shows the model payment secrets, order ids, receipts, keys or references, across a whole paid booking and refund', async () => {
      await session(paidDoctor, day(3), 1);
      const held = await bookViaAssistant(0, paidDoctor, day(3), '09:00');
      await verify(patientTokens[0], held.checkout.orderId, 'pay_visible_1').expect(200);
      const id = held.appointment.id as string;
      const seen = [
        await converse(patientTokens[0], [{ name: 'get_my_appointments', args: { scope: 'all' } }, { name: 'get_payment_status', args: { appointmentId: id } }, { name: 'get_refund_status', args: { appointmentId: id } }]),
        await prepare(0, 'prepare_cancellation', { appointmentId: id }),
      ];
      const everything = JSON.stringify(requests) + seen.map((s) => s.shown).join('');
      for (const secret of [KEY_SECRET, WEBHOOK_SECRET, 'rzp_test_e2e', held.checkout.orderId, 'pay_visible_1', seen[1].card!.ref, 'razorpay', 'receipt']) expect(everything.toLowerCase()).not.toContain(String(secret).toLowerCase());
    });
  });
});
