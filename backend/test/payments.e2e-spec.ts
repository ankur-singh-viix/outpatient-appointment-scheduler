import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EMAIL_SENDER, type EmailMessage } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { GatewayError, PAYMENT_GATEWAY, isValidIdempotencyKey, type GatewayRefund, type PaymentGateway } from '../src/payments/payment-gateway.js';
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
process.env.REFUND_FULL_HOURS_BEFORE = '1000'; // every booking in these tests is "late" for a full patient refund, so the 50% tier is exercised
process.env.REFUND_PARTIAL_HOURS_BEFORE = '2';
process.env.REFUND_PARTIAL_PERCENT = '50';
process.env.REMINDER_HOURS_BEFORE = '24,2';
process.env.BACKGROUND_JOBS = 'false'; // the tests run the workers themselves, exactly when they mean to

const PASSWORD = 'Test@1234';
const FEE_RUPEES = 650;
const FEE_PAISE = FEE_RUPEES * 100;
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
let dayCounter = 0;
/** A fresh future date for each test so slots never collide. */
const nextDay = () => addDays(today, 2 + (dayCounter++ % 25));

/**
 * Stands in for Razorpay, enforcing the refund rules its documentation states: the X-Refund-Idempotency key must be 10+ characters
 * of letters, digits, hyphens and underscores (else HTTP 400), a repeat with the same key and the same request returns the first
 * refund, and a repeat with a different request is rejected.
 */
class FakeGateway implements PaymentGateway {
  readonly enabled = true;
  readonly keyId = 'rzp_test_e2e';
  orders: { id: string; amountPaise: number; notes: Record<string, string> }[] = [];
  refundCalls: { paymentId: string; amountPaise: number; idempotencyKey: string; notes: Record<string, string> }[] = [];
  failOrders = false;
  /**
   * pending/processed: Razorpay answers. network-error: the request never arrived. rejected: Razorpay says no (HTTP 400).
   * ambiguous: Razorpay MADE the refund but the answer was lost. in-progress: HTTP 409, a repeat is still running.
   */
  refundMode: 'pending' | 'processed' | 'network-error' | 'rejected' | 'ambiguous' | 'in-progress' = 'pending';
  /** Every refund Razorpay actually created. */
  created: { refund: GatewayRefund; paymentId: string; notes: Record<string, string> }[] = [];
  private byKey = new Map<string, { payload: string; refund: GatewayRefund }>();
  refundState = new Map<string, GatewayRefund['status']>();
  private counter = 0;

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    if (this.failOrders) throw new GatewayError('Razorpay is down.');
    const order = { id: `order_${++this.counter}`, amountPaise: input.amountPaise, notes: input.notes };
    this.orders.push(order);
    return { id: order.id, amountPaise: input.amountPaise, currency: 'INR' };
  }

  async createRefund(input: { paymentId: string; amountPaise: number; idempotencyKey: string; notes: Record<string, string> }): Promise<GatewayRefund> {
    this.refundCalls.push({ paymentId: input.paymentId, amountPaise: input.amountPaise, idempotencyKey: input.idempotencyKey, notes: input.notes });
    if (!isValidIdempotencyKey(input.idempotencyKey)) throw new GatewayError('The idempotency key is invalid.', 400);
    if (this.refundMode === 'network-error') throw new GatewayError('Could not reach Razorpay.');
    if (this.refundMode === 'rejected') throw new GatewayError('The refund amount is invalid.', 400);
    if (this.refundMode === 'in-progress') throw new GatewayError('Another request with the same idempotency key is still in progress.', 409);
    const payload = JSON.stringify([input.paymentId, input.amountPaise, input.notes]);
    const repeat = this.byKey.get(input.idempotencyKey);
    if (repeat) {
      if (repeat.payload !== payload) throw new GatewayError('A different request with the same idempotency key was already processed.', 400);
      return repeat.refund; // like Razorpay: the same key and request returns the first refund
    }
    const refund: GatewayRefund = { id: `rfnd_${++this.counter}`, status: this.refundMode === 'processed' ? 'processed' : 'pending', amountPaise: input.amountPaise };
    this.byKey.set(input.idempotencyKey, { payload, refund });
    this.created.push({ refund, paymentId: input.paymentId, notes: input.notes });
    this.refundState.set(refund.id, refund.status);
    if (this.refundMode === 'ambiguous') throw new GatewayError('Could not reach Razorpay.'); // made, but we never heard
    return refund;
  }

  async fetchRefund(refundId: string): Promise<GatewayRefund> {
    return { id: refundId, status: this.refundState.get(refundId) ?? 'pending', amountPaise: 0 };
  }

  async findRefundByNote(paymentId: string, refundId: string): Promise<GatewayRefund | null> {
    if (this.refundMode === 'network-error') throw new GatewayError('Could not reach Razorpay.');
    return this.created.find((entry) => entry.paymentId === paymentId && entry.notes.refundId === refundId)?.refund ?? null;
  }
}

describe('Payments, refunds and notifications (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let freeDoctorId: string;
  let paymentsService: PaymentsService;
  let notifications: NotificationsService;
  let patientToken: string;
  let otherPatientToken: string;
  let doctorToken: string;
  let adminToken: string;
  const gateway = new FakeGateway();
  const sentEmails: EmailMessage[] = [];
  let failEmails = 0;
  const mailbox = {
    send: async (message: EmailMessage) => {
      if (failEmails > 0) {
        failEmails--;
        throw new Error('simulated provider outage');
      }
      sentEmails.push(message);
    },
  };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];

  const login = async (email: string) =>
    (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (token: string, date: string, startTime: string, doctor = doctorId) =>
    http().post('/api/appointments').set(as(token)).send({ doctorId: doctor, date, startTime });
  /** Books a held appointment and returns its ids. */
  const hold = async (token = patientToken, startTime = '10:00', date = nextDay()) => {
    const response = await book(token, date, startTime).expect(201);
    return { id: response.body.id as string, orderId: response.body.checkout.orderId as string, date, startTime, body: response.body };
  };
  const signature = (orderId: string, paymentId: string, secret = KEY_SECRET) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  let paymentCounter = 0;
  const verifyBody = (orderId: string, paymentId = `pay_${++paymentCounter}`) => ({
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: signature(orderId, paymentId),
  });
  /** Pays for a hold the way the browser does and returns the payment id used. */
  const payFor = async (orderId: string, token = patientToken) => {
    const body = verifyBody(orderId);
    await http().post('/api/payments/verify').set(as(token)).send(body).expect(200);
    return body.razorpayPaymentId;
  };
  const webhook = (event: object, options: { secret?: string; eventId?: string; signature?: string } = {}) => {
    const raw = JSON.stringify(event);
    const sig = options.signature ?? createHmac('sha256', options.secret ?? WEBHOOK_SECRET).update(raw).digest('hex');
    return http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', sig)
      .set('x-razorpay-event-id', options.eventId ?? `evt_${randomUUID()}`)
      .send(raw);
  };
  const captured = (orderId: string, paymentId: string, amount = FEE_PAISE) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured' } } },
  });
  const refundEvent = (type: string, refundId: string, paymentId: string, amount: number) => ({
    event: type,
    payload: { refund: { entity: { id: refundId, payment_id: paymentId, amount, status: type.replace('refund.', '') } } },
  });
  const status = async (id: string) => (await one<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [id])).status;
  const paymentOf = (appointmentId: string) => one<{ id: string; status: string; razorpay_payment_id: string | null; amount_paise: number }>('SELECT * FROM payments WHERE appointment_id = $1 ORDER BY created_at DESC', [appointmentId]);
  const refundsOf = (appointmentId: string) =>
    rows<{ id: string; status: string; amount_paise: number; razorpay_refund_id: string | null; reason: string; failure_reason: string | null }>(
      'SELECT r.* FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.appointment_id = $1 ORDER BY r.created_at',
      [appointmentId],
    );
  const queued = (appointmentId: string, kind?: string) =>
    rows<{ kind: string; status: string; send_at: Date; subject: string; attempts: number; recipient_role: string | null; channel: string; to_address: string }>(
      `SELECT * FROM notifications WHERE appointment_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY created_at, kind`,
      kind ? [appointmentId, kind] : [appointmentId],
    );
  const sentTo = (subject: RegExp) => sentEmails.filter((email) => subject.test(email.subject));

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);

    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Test Clinic', '1 Test St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string, fee: number) => {
      const userId = await user(name, email, 'DOCTOR');
      const id = (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
           VALUES ($1, $2, $3, 15, 10, $4) RETURNING id`,
          [userId, clinicId, specialtyId, fee],
        )
      ).rows[0].id as string;
      for (let day = 0; day < 7; day++) {
        await db.query("INSERT INTO availability (doctor_id, day_of_week, start_time, end_time, capacity) VALUES ($1, $2, '10:00', '11:00', 4)", [id, day]);
      }
      return id;
    };
    doctorId = await makeDoctor('Dr. Paid Doctor', 'doctor@test.local', FEE_RUPEES);
    freeDoctorId = await makeDoctor('Dr. Free Doctor', 'free.doctor@test.local', 0);
    for (const [name, email] of [
      ['Pat One', 'patient1@test.local'],
      ['Pat Two', 'patient2@test.local'],
    ]) {
      const id = await user(name, email, 'PATIENT');
      await db.query('INSERT INTO patients (user_id) VALUES ($1)', [id]);
    }
    await user('Admin Person', 'admin@test.local', 'ADMIN');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailbox)
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    paymentsService = app.get(PaymentsService);
    notifications = app.get(NotificationsService);

    patientToken = await login('patient1@test.local');
    otherPatientToken = await login('patient2@test.local');
    doctorToken = await login('doctor@test.local');
    adminToken = await login('admin@test.local');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    // Every test starts from the same clean slate: no appointments, payments, refunds or messages.
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments;');
    gateway.orders = [];
    gateway.refundCalls = [];
    gateway.created = [];
    gateway.failOrders = false;
    gateway.refundMode = 'pending';
    sentEmails.length = 0;
    failEmails = 0;
  });

  describe('public settings', () => {
    it('tells the booking screen whether payment is on and the refund rules, with nothing secret', async () => {
      const response = await http().get('/api/payments/config').expect(200);
      expect(response.body).toEqual({
        enabled: true,
        holdMinutes: 15,
        refundPolicy: { fullRefundHoursBefore: 1000, partialRefundHoursBefore: 2, partialRefundPercent: 50 },
      });
      expect(JSON.stringify(response.body)).not.toMatch(/secret|rzp_/i);
    });
  });

  describe('starting a payment', () => {
    it('holds the slot and opens an order for the fee stored in the database', async () => {
      const held = await hold();
      expect(held.body.status).toBe('PENDING');
      expect(held.body.holdExpiresAt).toBeTruthy();
      expect(gateway.orders).toHaveLength(1);
      expect(gateway.orders[0].amountPaise).toBe(FEE_PAISE);
      expect(held.body.checkout).toMatchObject({ orderId: held.orderId, amountPaise: FEE_PAISE, currency: 'INR', keyId: 'rzp_test_e2e' });
      expect(JSON.stringify(held.body)).not.toContain(KEY_SECRET);
      expect(await paymentOf(held.id)).toMatchObject({ status: 'CREATED', amount_paise: FEE_PAISE });
      // The unpaid hold is not a confirmed booking: no confirmation email, no reminders.
      expect(await queued(held.id)).toHaveLength(0);
    });

    it('ignores any price the browser sends: the request body is strict', async () => {
      const response = await http().post('/api/appointments').set(as(patientToken)).send({ doctorId, date: nextDay(), startTime: '10:00', amount: 1, amountPaise: 100 });
      expect(response.status).toBe(400);
      expect(gateway.orders).toHaveLength(0);
    });

    it('keeps the slot held so nobody else can take it, and gives it back when the hold ends', async () => {
      const date = nextDay();
      const first = await hold(patientToken, '10:00', date);
      await book(otherPatientToken, date, '10:00').expect(409);

      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [first.id]);
      // Even before the worker runs, booking frees a lapsed hold for itself.
      const second = await book(otherPatientToken, date, '10:00').expect(201);
      expect(second.body.status).toBe('PENDING');
      expect(await status(first.id)).toBe('CANCELLED');
      expect((await paymentOf(first.id)).status).toBe('EXPIRED');
    });

    it('shows a lapsed hold as free straight away, even though no worker has cancelled it yet', async () => {
      const date = nextDay();
      const first = await hold(patientToken, '10:00', date);
      const slots = async () => ((await http().get(`/api/doctors/${doctorId}/slots`).query({ date }).expect(200)).body.slots as { startTime: string; status: string }[]).find((slot) => slot.startTime === '10:00')!.status;
      expect(await slots()).toBe('BOOKED');

      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [first.id]);
      expect(await status(first.id)).toBe('PENDING'); // nothing has cancelled it
      expect(await slots()).toBe('AVAILABLE'); // but it no longer blocks the slot, so a patient can pick it
      await book(otherPatientToken, date, '10:00').expect(201);
    });

    it('lets a patient reschedule into a slot whose unpaid hold has lapsed', async () => {
      const date = nextDay();
      const paid = await hold(patientToken, '10:00', date);
      await payFor(paid.orderId);
      const target = await hold(otherPatientToken, '10:15', date);
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [target.id]);
      await http().post(`/api/appointments/${paid.id}/reschedule`).set(as(patientToken)).send({ date, startTime: '10:15' }).expect(201);
      expect(await status(target.id)).toBe('CANCELLED');
    });

    it('confirms immediately, with no payment, for a doctor whose fee is zero', async () => {
      const response = await book(patientToken, nextDay(), '10:00', freeDoctorId).expect(201);
      expect(response.body.status).toBe('CONFIRMED');
      expect(response.body.checkout).toBeUndefined();
      expect(gateway.orders).toHaveLength(0);
    });

    it('releases the hold and says so when Razorpay cannot create the order', async () => {
      gateway.failOrders = true;
      const date = nextDay();
      const response = await book(patientToken, date, '10:00').expect(503);
      expect(response.body.message).toMatch(/could not start the payment/i);
      gateway.failOrders = false;
      await book(otherPatientToken, date, '10:00').expect(201); // the slot is free again
    });

    it('caps how many unpaid holds one patient can keep', async () => {
      const date = nextDay();
      for (const time of ['10:00', '10:15', '10:30']) await book(patientToken, date, time).expect(201);
      const fourth = await book(patientToken, date, '10:45').expect(409);
      expect(fourth.body.message).toMatch(/waiting for payment/i);
    });
  });

  describe('confirming a payment from the browser', () => {
    it('rejects a forged signature and changes nothing', async () => {
      const held = await hold();
      const forged = { ...verifyBody(held.orderId), razorpaySignature: signature(held.orderId, 'pay_other', 'not-the-secret') };
      await http().post('/api/payments/verify').set(as(patientToken)).send(forged).expect(400);
      await http().post('/api/payments/verify').set(as(patientToken)).send({ ...verifyBody(held.orderId), razorpaySignature: 'zz' }).expect(400);
      expect(await status(held.id)).toBe('PENDING');
      expect((await paymentOf(held.id)).status).toBe('CREATED');
    });

    it('confirms the booking, records the payment, and queues the emails and reminders', async () => {
      const held = await hold();
      const paymentId = await payFor(held.orderId);
      expect(await status(held.id)).toBe('CONFIRMED');
      expect(await paymentOf(held.id)).toMatchObject({ status: 'PAID', razorpay_payment_id: paymentId });
      expect((await one<{ hold_expires_at: Date | null }>('SELECT hold_expires_at FROM appointments WHERE id = $1', [held.id])).hold_expires_at).toBeNull();

      const kinds = (await queued(held.id)).map((row) => `${row.recipient_role}:${row.kind}`).sort();
      // The patient gets the confirmation, the receipt and two reminders; the doctor gets a heads-up about the booking.
      expect(kinds).toEqual(['DOCTOR:booking-confirmed', 'PATIENT:booking-confirmed', 'PATIENT:payment-received', 'PATIENT:reminder', 'PATIENT:reminder']);

      await notifications.dispatchDue();
      expect(sentTo(/appointment confirmed/i)).toHaveLength(1);
      expect(sentTo(/payment received/i)).toHaveLength(1);
      expect(sentTo(/reminder/i)).toHaveLength(0); // the reminders are for tomorrow and the day before, not now
      expect(sentEmails.map((email) => email.to).sort()).toEqual(['doctor@test.local', 'patient1@test.local', 'patient1@test.local']);
      expect(sentTo(/new booking/i).map((email) => email.to)).toEqual(['doctor@test.local']);
    });

    it('is safe to repeat: the second call changes nothing and queues nothing new', async () => {
      const held = await hold();
      const body = verifyBody(held.orderId);
      await http().post('/api/payments/verify').set(as(patientToken)).send(body).expect(200);
      await http().post('/api/payments/verify').set(as(patientToken)).send(body).expect(200);
      expect(await queued(held.id, 'booking-confirmed')).toHaveLength(2); // one for the patient, one for the doctor
      expect(await rows('SELECT 1 FROM payments WHERE appointment_id = $1', [held.id])).toHaveLength(1);
    });

    it("does not let one patient confirm, or even see, another patient's order", async () => {
      const held = await hold();
      await http().post('/api/payments/verify').set(as(otherPatientToken)).send(verifyBody(held.orderId)).expect(404);
      await http().post(`/api/payments/appointments/${held.id}/checkout`).set(as(otherPatientToken)).expect(404);
      expect(await status(held.id)).toBe('PENDING');
    });

    it('needs a patient sign-in', async () => {
      await http().post('/api/payments/verify').send(verifyBody('order_x')).expect(401);
      await http().post('/api/payments/verify').set(as(doctorToken)).send(verifyBody('order_x')).expect(403);
    });
  });

  describe('retries, failures and abandoned payments', () => {
    it('lets the patient retry a failed payment on the same order, then succeed', async () => {
      const held = await hold();
      await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_fail', order_id: held.orderId, error_description: 'Card declined' } } } }).expect(200);
      expect(await paymentOf(held.id)).toMatchObject({ status: 'FAILED' });
      expect(await status(held.id)).toBe('PENDING'); // still held, still payable

      const again = await http().post(`/api/payments/appointments/${held.id}/checkout`).set(as(patientToken)).expect(200);
      expect(again.body.orderId).toBe(held.orderId); // same order, not a second charge
      expect(gateway.orders).toHaveLength(1);

      await payFor(held.orderId);
      expect(await status(held.id)).toBe('CONFIRMED');
    });

    it('does not let a failure event undo a payment that already succeeded', async () => {
      const held = await hold();
      await payFor(held.orderId);
      await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_x', order_id: held.orderId } } } }).expect(200);
      expect((await paymentOf(held.id)).status).toBe('PAID');
      expect(await status(held.id)).toBe('CONFIRMED');
    });

    it('releases an abandoned booking when its hold runs out, and says so', async () => {
      const held = await hold();
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [held.id]);
      expect(await paymentsService.expireHolds()).toBe(1);
      expect(await status(held.id)).toBe('CANCELLED');
      expect((await paymentOf(held.id)).status).toBe('EXPIRED');
      expect(await paymentsService.expireHolds()).toBe(0); // nothing left to release

      await http().post(`/api/payments/appointments/${held.id}/checkout`).set(as(patientToken)).expect(409);
      await notifications.dispatchDue();
      expect(sentTo(/appointment cancelled/i)).toHaveLength(1);
    });

    it('does not release a hold that has not run out yet', async () => {
      const held = await hold();
      expect(await paymentsService.expireHolds()).toBe(0);
      expect(await status(held.id)).toBe('PENDING');
    });

    it('refunds in full when the money arrives after the hold was released', async () => {
      const held = await hold();
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [held.id]);
      await paymentsService.expireHolds();

      await webhook(captured(held.orderId, 'pay_late')).expect(200);
      expect(await status(held.id)).toBe('CANCELLED'); // the slot is not given back to someone who paid too late
      expect((await paymentOf(held.id)).status).toBe('PAID');
      const refunds = await refundsOf(held.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ amount_paise: FEE_PAISE, status: 'PENDING' });
      expect(gateway.refundCalls).toHaveLength(1);
    });

    it('does not let the patient move an unpaid booking to a new time', async () => {
      const held = await hold();
      const response = await http().post(`/api/appointments/${held.id}/reschedule`).set(as(patientToken)).send({ date: nextDay(), startTime: '10:15' }).expect(409);
      expect(response.body.message).toMatch(/paying/i);
    });

    it('cancelling an unpaid booking frees the slot and closes the order', async () => {
      const held = await hold();
      await http().post(`/api/appointments/${held.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      expect((await paymentOf(held.id)).status).toBe('EXPIRED');
      expect(await refundsOf(held.id)).toHaveLength(0); // nothing was paid, so nothing to refund
      await book(otherPatientToken, held.date, '10:00').expect(201);
    });
  });

  describe('webhooks', () => {
    it('refuses a bad or missing signature and a body that was changed after signing', async () => {
      const held = await hold();
      const event = captured(held.orderId, 'pay_hook');
      await webhook(event, { signature: 'deadbeef' }).expect(401);
      await webhook(event, { secret: 'the-wrong-secret' }).expect(401);
      await http().post('/api/payments/webhook').set('Content-Type', 'application/json').send(JSON.stringify(event)).expect(401);

      const raw = JSON.stringify(event);
      const goodSignature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      await http()
        .post('/api/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', goodSignature)
        .send(raw.replace('pay_hook', 'pay_evil'))
        .expect(401);
      expect(await status(held.id)).toBe('PENDING');
    });

    it('verifies the signature against the exact bytes received, not a re-serialised copy', async () => {
      const held = await hold();
      const raw = JSON.stringify(captured(held.orderId, 'pay_spaced'), null, 4); // unusual whitespace a re-serialiser would change
      const sig = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      await http().post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).set('x-razorpay-event-id', 'evt_spaced').send(raw).expect(200);
      expect(await status(held.id)).toBe('CONFIRMED');
    });

    it('confirms a booking from a captured payment even if the browser never reported back', async () => {
      const held = await hold();
      await webhook(captured(held.orderId, 'pay_hook')).expect(200);
      expect(await status(held.id)).toBe('CONFIRMED');
      expect(await paymentOf(held.id)).toMatchObject({ status: 'PAID', razorpay_payment_id: 'pay_hook' });
    });

    it('acknowledges a redelivered event and does not apply it twice', async () => {
      const held = await hold();
      const first = await webhook(captured(held.orderId, 'pay_dup'), { eventId: 'evt_same' }).expect(200);
      expect(first.body).toEqual({ received: true });
      const second = await webhook(captured(held.orderId, 'pay_dup'), { eventId: 'evt_same' }).expect(200);
      expect(second.body).toEqual({ received: true, duplicate: true });
      expect(await queued(held.id, 'booking-confirmed')).toHaveLength(2);
      expect(await rows("SELECT 1 FROM payment_events WHERE event_id = 'evt_same'")).toHaveLength(1);
    });

    it('is harmless when the same payment arrives under a different event id, or after the browser already confirmed it', async () => {
      const held = await hold();
      const paymentId = await payFor(held.orderId);
      await webhook(captured(held.orderId, paymentId), { eventId: 'evt_a' }).expect(200);
      await webhook({ ...captured(held.orderId, paymentId), event: 'order.paid' }, { eventId: 'evt_b' }).expect(200);
      expect(await queued(held.id, 'booking-confirmed')).toHaveLength(2);
      expect(await queued(held.id, 'payment-received')).toHaveLength(1);
      expect(await refundsOf(held.id)).toHaveLength(0);
    });

    it('ignores a captured payment whose amount does not match the order', async () => {
      const held = await hold();
      await webhook(captured(held.orderId, 'pay_cheap', 100)).expect(200);
      expect(await status(held.id)).toBe('PENDING');
      expect((await paymentOf(held.id)).status).toBe('CREATED');
    });

    it('ignores events about orders that are not ours, and event types it does not handle', async () => {
      await webhook(captured('order_somebody_else', 'pay_x')).expect(200);
      await webhook({ event: 'subscription.charged', payload: {} }).expect(200);
    });
  });

  describe('refunds', () => {
    const paidBooking = async (startTime = '10:00') => {
      const held = await hold(patientToken, startTime);
      const paymentId = await payFor(held.orderId);
      return { ...held, paymentId };
    };

    it('refunds the policy share when the patient cancels, and is not "completed" until Razorpay confirms', async () => {
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({ reason: 'Plans changed' }).expect(200);

      // 3 days ahead is inside the (test-configured) full-refund window, so it is the 50% tier.
      let refunds = await refundsOf(booking.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount_paise).toBe(FEE_PAISE / 2);
      expect(refunds[0].reason).toMatch(/50% refund/);
      expect(gateway.refundCalls).toHaveLength(1);
      expect(gateway.refundCalls[0]).toMatchObject({ paymentId: booking.paymentId, amountPaise: FEE_PAISE / 2, idempotencyKey: `rfnd-${refunds[0].id}`, notes: { refundId: refunds[0].id } });
      // Razorpay accepted it but has not finished: it must still read PENDING, with its reference stored.
      expect(refunds[0].status).toBe('PENDING');
      expect(refunds[0].razorpay_refund_id).toBeTruthy();

      // Only Razorpay's confirmation completes it.
      await webhook(refundEvent('refund.processed', refunds[0].razorpay_refund_id!, booking.paymentId, FEE_PAISE / 2)).expect(200);
      refunds = await refundsOf(booking.id);
      expect(refunds[0].status).toBe('PROCESSED');

      await notifications.dispatchDue();
      expect(sentTo(/refund started/i)).toHaveLength(1);
      expect(sentTo(/refund processed/i)).toHaveLength(1);
      const cancellation = sentTo(/appointment cancelled/i);
      expect(cancellation).toHaveLength(1);
      expect(cancellation[0].text).toMatch(/50% refund/);
    });

    it('treats a refund reported as processed by Razorpay immediately as complete, and no sooner', async () => {
      gateway.refundMode = 'processed';
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      expect((await refundsOf(booking.id))[0].status).toBe('PROCESSED');
    });

    it('always refunds in full when the doctor cancels', async () => {
      const booking = await paidBooking();
      await http()
        .post(`/api/doctor-portal/appointments/${booking.id}/cancel`)
        .set(as(doctorToken))
        .send({ reason: 'Emergency surgery' })
        .expect(200);
      const refunds = await refundsOf(booking.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount_paise).toBe(FEE_PAISE);
      expect(refunds[0].reason).toMatch(/cancelled by the clinic/i);
    });

    it('records a failure Razorpay reports and lets the amount be refunded again', async () => {
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      const [refund] = await refundsOf(booking.id);
      await webhook(refundEvent('refund.failed', refund.razorpay_refund_id!, booking.paymentId, refund.amount_paise)).expect(200);
      expect((await refundsOf(booking.id))[0].status).toBe('FAILED');
      // A failed refund no longer counts against the payment, so an administrator can refund it in full.
      const payment = await paymentOf(booking.id);
      await http()
        .post(`/api/payments/${payment.id}/refund`)
        .set(as(adminToken))
        .send({ reason: 'Retry after failure', requestId: randomUUID() })
        .expect(201);
    });

    it('retries a refund Razorpay could not be reached for, with the same idempotency key', async () => {
      gateway.refundMode = 'network-error';
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      let [refund] = await refundsOf(booking.id);
      expect(refund.status).toBe('PENDING');
      expect(refund.razorpay_refund_id).toBeNull();
      expect(refund.failure_reason).toMatch(/could not reach/i);

      gateway.refundMode = 'pending';
      await paymentsService.settleRefunds(new Date(Date.now() + 5 * 60_000));
      [refund] = await refundsOf(booking.id);
      expect(refund.razorpay_refund_id).toBeTruthy();
      // The retry is the SAME request: same key, amount and notes, so Razorpay can recognise it as a repeat.
      expect(gateway.refundCalls).toHaveLength(2);
      expect(gateway.refundCalls[1]).toEqual(gateway.refundCalls[0]);

      // Running the worker again must not create a second refund.
      await paymentsService.settleRefunds(new Date(Date.now() + 10 * 60_000));
      expect(await refundsOf(booking.id)).toHaveLength(1);
    });

    it('marks a refund FAILED, and tells the patient, when Razorpay refuses it outright', async () => {
      gateway.refundMode = 'rejected';
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      const [refund] = await refundsOf(booking.id);
      expect(refund.status).toBe('FAILED');
      expect(refund.failure_reason).toMatch(/invalid/i);
      await notifications.dispatchDue();
      expect(sentTo(/refund failed/i)).toHaveLength(1);
    });

    it('settles a refund the worker finds Razorpay has finished', async () => {
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      const [refund] = await refundsOf(booking.id);
      gateway.refundState.set(refund.razorpay_refund_id!, 'processed');
      await paymentsService.settleRefunds(new Date(Date.now() + 5 * 60_000));
      expect((await refundsOf(booking.id))[0].status).toBe('PROCESSED');
    });

    it('records a refund made from the Razorpay dashboard', async () => {
      const booking = await paidBooking();
      await webhook(refundEvent('refund.processed', 'rfnd_dashboard', booking.paymentId, 10000)).expect(200);
      const refunds = await refundsOf(booking.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ status: 'PROCESSED', amount_paise: 10000, razorpay_refund_id: 'rfnd_dashboard' });
    });

    it("uses an idempotency key Razorpay accepts for every kind of refund (automatic, late, and an administrator's)", async () => {
      // The fake rejects an invalid key with HTTP 400, as Razorpay does, so any bad key would leave these refunds FAILED.
      const cancelled = await paidBooking('10:00');
      await http().post(`/api/appointments/${cancelled.id}/cancel`).set(as(patientToken)).send({}).expect(200);

      const lateHold = await hold(patientToken, '10:15');
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [lateHold.id]);
      await paymentsService.expireHolds();
      await webhook(captured(lateHold.orderId, 'pay_late_key')).expect(200);

      const manual = await paidBooking('10:30');
      await http().post(`/api/payments/${(await paymentOf(manual.id)).id}/refund`).set(as(adminToken)).send({ amountPaise: 1000, reason: 'Goodwill', requestId: randomUUID() }).expect(201);

      expect(gateway.refundCalls).toHaveLength(3);
      for (const call of gateway.refundCalls) expect(call.idempotencyKey).toMatch(/^rfnd-[0-9a-f-]{36}$/);
      for (const appointmentId of [cancelled.id, lateHold.id, manual.id]) {
        expect((await refundsOf(appointmentId)).every((refund) => refund.status === 'PENDING' && refund.razorpay_refund_id !== null)).toBe(true);
      }
    });

    it('adopts a refund Razorpay made but whose answer was lost, and never makes a second one', async () => {
      gateway.refundMode = 'ambiguous';
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      let [refund] = await refundsOf(booking.id);
      expect(refund.status).toBe('PENDING'); // not FAILED: we do not know, so we do not guess
      expect(refund.razorpay_refund_id).toBeNull();
      expect(gateway.created).toHaveLength(1); // Razorpay did make it

      gateway.refundMode = 'pending';
      await paymentsService.settleRefunds(new Date(Date.now() + 5 * 60_000));
      [refund] = await refundsOf(booking.id);
      expect(refund.razorpay_refund_id).toBe(gateway.created[0].refund.id); // adopted the existing refund
      expect(gateway.created).toHaveLength(1); // and made no second one
      expect(gateway.refundCalls).toHaveLength(1); // not even a second request
      expect(await refundsOf(booking.id)).toHaveLength(1);
    });

    it('never marks a refund FAILED because of network trouble, however many times it is retried', async () => {
      gateway.refundMode = 'network-error';
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      for (let attempt = 1; attempt <= 5; attempt++) await paymentsService.settleRefunds(new Date(Date.now() + attempt * 5 * 60_000));
      const [refund] = await refundsOf(booking.id);
      expect(refund.status).toBe('PENDING');
      expect(gateway.created).toHaveLength(0);
    });

    it('keeps a refund pending and retries while Razorpay says the same request is still in progress (HTTP 409)', async () => {
      gateway.refundMode = 'in-progress';
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      expect((await refundsOf(booking.id))[0].status).toBe('PENDING');
      gateway.refundMode = 'pending';
      await paymentsService.settleRefunds(new Date(Date.now() + 5 * 60_000));
      const [refund] = await refundsOf(booking.id);
      expect(refund.status).toBe('PENDING');
      expect(refund.razorpay_refund_id).toBeTruthy();
      expect(gateway.created).toHaveLength(1);
    });

    it('caps an automatic refund at what is still left after an earlier refund', async () => {
      const booking = await paidBooking();
      const payment = await paymentOf(booking.id);
      await http()
        .post(`/api/payments/${payment.id}/refund`)
        .set(as(adminToken))
        .send({ amountPaise: FEE_PAISE - 5000, reason: 'Goodwill', requestId: randomUUID() })
        .expect(201);
      // The 50% policy refund would be 32,500 paise, but only 5,000 is left.
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      const refunds = await refundsOf(booking.id);
      expect(refunds.map((row) => row.amount_paise).sort((a, b) => a - b)).toEqual([5000, FEE_PAISE - 5000]);
      expect(refunds.reduce((sum, row) => sum + row.amount_paise, 0)).toBe(FEE_PAISE);
    });

    it('creates no automatic refund at all when everything was already refunded', async () => {
      const booking = await paidBooking();
      const payment = await paymentOf(booking.id);
      await http().post(`/api/payments/${payment.id}/refund`).set(as(adminToken)).send({ reason: 'Full goodwill refund', requestId: randomUUID() }).expect(201);
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      expect(await refundsOf(booking.id)).toHaveLength(1);
      expect(gateway.refundCalls).toHaveLength(1);
    });

    describe('by an administrator', () => {
      it('is refused for anyone who is not an administrator', async () => {
        const booking = await paidBooking();
        const payment = await paymentOf(booking.id);
        const body = { reason: 'Goodwill', requestId: randomUUID() };
        await http().post(`/api/payments/${payment.id}/refund`).set(as(patientToken)).send(body).expect(403);
        await http().post(`/api/payments/${payment.id}/refund`).set(as(doctorToken)).send(body).expect(403);
        await http().post(`/api/payments/${payment.id}/refund`).send(body).expect(401);
        expect(await refundsOf(booking.id)).toHaveLength(0);
      });

      it('refunds part of a payment, once, even if the request is sent twice', async () => {
        const booking = await paidBooking();
        const payment = await paymentOf(booking.id);
        const body = { amountPaise: 20000, reason: 'Goodwill gesture', requestId: randomUUID() };
        const first = await http().post(`/api/payments/${payment.id}/refund`).set(as(adminToken)).send(body).expect(201);
        const second = await http().post(`/api/payments/${payment.id}/refund`).set(as(adminToken)).send(body).expect(201);
        expect(second.body.id).toBe(first.body.id);
        expect(await refundsOf(booking.id)).toHaveLength(1);
        expect(first.body).toMatchObject({ amountPaise: 20000, status: 'PENDING' });
      });

      it('never refunds more than was paid, across several refunds', async () => {
        const booking = await paidBooking();
        const payment = await paymentOf(booking.id);
        const refund = (amountPaise?: number) =>
          http().post(`/api/payments/${payment.id}/refund`).set(as(adminToken)).send({ ...(amountPaise ? { amountPaise } : {}), reason: 'Goodwill', requestId: randomUUID() });
        await refund(FEE_PAISE - 1000).expect(201);
        const tooMuch = await refund(2000).expect(400);
        expect(tooMuch.body.message).toMatch(/left to refund/i);
        await refund(1000).expect(201); // exactly what is left
        await refund().expect(409); // nothing left at all
        const total = (await refundsOf(booking.id)).reduce((sum, row) => sum + row.amount_paise, 0);
        expect(total).toBe(FEE_PAISE);
      });

      it('cannot refund a payment that was never paid, or one that does not exist', async () => {
        const held = await hold();
        const unpaid = await paymentOf(held.id);
        const body = { reason: 'Goodwill', requestId: randomUUID() };
        await http().post(`/api/payments/${unpaid.id}/refund`).set(as(adminToken)).send(body).expect(409);
        await http().post(`/api/payments/${randomUUID()}/refund`).set(as(adminToken)).send(body).expect(404);
      });

      it('requires a reason and a request id', async () => {
        const booking = await paidBooking();
        const payment = await paymentOf(booking.id);
        await http().post(`/api/payments/${payment.id}/refund`).set(as(adminToken)).send({ requestId: randomUUID() }).expect(400);
        await http().post(`/api/payments/${payment.id}/refund`).set(as(adminToken)).send({ reason: 'Goodwill' }).expect(400);
      });
    });
  });

  describe('rescheduling a paid booking', () => {
    it('carries the payment to the new time with no refund and no second charge, and moves the reminders', async () => {
      const booking = await hold();
      await payFor(booking.orderId);
      const newDate = nextDay();
      const moved = await http().post(`/api/appointments/${booking.id}/reschedule`).set(as(patientToken)).send({ date: newDate, startTime: '10:15' }).expect(201);

      expect(await refundsOf(booking.id)).toHaveLength(0);
      expect(gateway.orders).toHaveLength(1);
      expect(await paymentOf(moved.body.id)).toMatchObject({ status: 'PAID' });
      expect(await rows('SELECT 1 FROM payments WHERE appointment_id = $1', [booking.id])).toHaveLength(0);
      expect(moved.body.payment).toMatchObject({ displayStatus: 'PAID', amountPaise: FEE_PAISE });

      const oldReminders = await queued(booking.id, 'reminder');
      expect(oldReminders.length).toBe(2);
      expect(oldReminders.every((row) => row.status === 'CANCELLED')).toBe(true);
      const newReminders = await queued(moved.body.id, 'reminder');
      expect(newReminders.length).toBe(2);
      expect(newReminders.every((row) => row.status === 'PENDING')).toBe(true);
      expect(await queued(moved.body.id, 'booking-rescheduled')).toHaveLength(2); // the patient and the doctor
    });
  });

  describe('notifications and reminders', () => {
    const confirmed = async () => {
      const held = await hold();
      await payFor(held.orderId);
      return held;
    };

    it('schedules each configured reminder at the right time before the appointment', async () => {
      const booking = await confirmed();
      const reminders = await queued(booking.id, 'reminder');
      expect(reminders).toHaveLength(2);
      const times = reminders.map((row) => row.send_at.getTime()).sort((a, b) => a - b);
      // 10:00 in Asia/Kolkata is 04:30 UTC. Reminders go out 24h and 2h earlier.
      const start = new Date(`${booking.date}T04:30:00Z`).getTime();
      if ((process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata') === 'Asia/Kolkata') {
        expect(times).toEqual([start - 24 * 3_600_000, start - 2 * 3_600_000]);
      }
    });

    it('sends a due reminder exactly once', async () => {
      const booking = await confirmed();
      await db.query("UPDATE notifications SET send_at = now() - interval '1 minute' WHERE appointment_id = $1 AND kind = 'reminder'", [booking.id]);
      const first = await notifications.dispatchDue();
      expect(first.sent).toBeGreaterThanOrEqual(2);
      expect(sentTo(/^Reminder:/)).toHaveLength(2);
      const second = await notifications.dispatchDue();
      expect(second.sent).toBe(0);
      expect(sentTo(/^Reminder:/)).toHaveLength(2);
    });

    it('withdraws pending reminders when the appointment is cancelled, so none is ever sent', async () => {
      const booking = await confirmed();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      const reminders = await queued(booking.id, 'reminder');
      expect(reminders.every((row) => row.status === 'CANCELLED')).toBe(true);
      await db.query("UPDATE notifications SET send_at = now() - interval '1 minute' WHERE appointment_id = $1", [booking.id]);
      await notifications.dispatchDue();
      expect(sentTo(/^Reminder:/)).toHaveLength(0);
    });

    it('still skips a reminder for a cancelled appointment even if it was somehow left pending', async () => {
      const booking = await confirmed();
      await db.query("UPDATE appointments SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = booked_by_user_id WHERE id = $1", [booking.id]);
      await db.query("UPDATE notifications SET send_at = now() - interval '1 minute' WHERE appointment_id = $1 AND kind = 'reminder'", [booking.id]);
      const result = await notifications.dispatchDue();
      expect(result.skipped).toBe(2);
      expect(sentTo(/^Reminder:/)).toHaveLength(0);
    });

    it('does not schedule a reminder whose time has already passed', async () => {
      // 24 hours before an appointment that is under a day away would be in the past.
      const held = await hold(patientToken, '10:00', addDays(today, 1));
      await payFor(held.orderId);
      const reminders = await queued(held.id, 'reminder');
      const now = Date.now();
      expect(reminders.every((row) => row.send_at.getTime() > now)).toBe(true);
    });

    it('retries a failed delivery later and gives up after repeated failures, without touching the booking', async () => {
      const booking = await confirmed();
      failEmails = 1;
      let result = await notifications.dispatchDue();
      expect(result.failed).toBe(1);
      expect(await status(booking.id)).toBe('CONFIRMED');
      const retrying = (await queued(booking.id)).filter((row) => row.status === 'PENDING' && row.attempts === 1);
      expect(retrying).toHaveLength(1);
      expect(sentEmails).toHaveLength(2); // the other two messages (the doctor's and the receipt) went out in the same pass

      // Not due again yet...
      result = await notifications.dispatchDue();
      expect(result.sent).toBe(0);
      // ...but after the backoff it goes out.
      result = await notifications.dispatchDue(new Date(Date.now() + 2 * 60_000));
      expect(result.sent).toBe(1);
      expect(sentTo(/appointment confirmed|payment received/i)).toHaveLength(2);
    });

    it('marks a message FAILED after the maximum number of attempts', async () => {
      const booking = await confirmed();
      failEmails = 1000;
      let at = Date.now();
      for (let attempt = 0; attempt < 6; attempt++) {
        at += 3 * 3_600_000;
        await notifications.dispatchDue(new Date(at));
      }
      const statuses = (await queued(booking.id)).filter((row) => row.kind !== 'reminder').map((row) => row.status);
      expect(statuses.every((value) => value === 'FAILED')).toBe(true);
    });

    it('never queues the same message twice for the same event', async () => {
      const booking = await confirmed();
      const before = (await queued(booking.id)).length;
      await webhook(captured(booking.orderId, (await paymentOf(booking.id)).razorpay_payment_id!), { eventId: 'evt_replay' }).expect(200);
      expect((await queued(booking.id)).length).toBe(before);
    });
  });

  describe('what the patient sees', () => {
    it('lists payments with receipts, and shows refunds only as complete once Razorpay confirms', async () => {
      const held = await hold();
      const paymentId = await payFor(held.orderId);
      await http().post(`/api/appointments/${held.id}/cancel`).set(as(patientToken)).send({}).expect(200);

      let history = (await http().get('/api/payments/mine').set(as(patientToken)).expect(200)).body;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: 'PAID', displayStatus: 'REFUND_PENDING', amountPaise: FEE_PAISE, receiptNumber: paymentId, refundedPaise: 0 });
      expect(history[0].appointment).toMatchObject({ doctorName: 'Dr. Paid Doctor', status: 'CANCELLED' });
      expect(history[0].refunds[0]).toMatchObject({ status: 'PENDING', amountPaise: FEE_PAISE / 2 });

      const [refund] = await refundsOf(held.id);
      await webhook(refundEvent('refund.processed', refund.razorpay_refund_id!, paymentId, FEE_PAISE / 2)).expect(200);
      history = (await http().get('/api/payments/mine').set(as(patientToken)).expect(200)).body;
      expect(history[0]).toMatchObject({ displayStatus: 'PARTIALLY_REFUNDED', refundedPaise: FEE_PAISE / 2 });
      expect(history[0].refunds[0]).toMatchObject({ status: 'PROCESSED', reference: refund.razorpay_refund_id });
    });

    it("shows another patient's payments to nobody", async () => {
      const paid = await hold();
      await payFor(paid.orderId);
      const mine = (await http().get('/api/payments/mine').set(as(patientToken)).expect(200)).body;
      expect(mine).toHaveLength(1);
      const theirs = (await http().get('/api/payments/mine').set(as(otherPatientToken)).expect(200)).body;
      expect(theirs).toHaveLength(0);
      await http().get('/api/payments/mine').expect(401);
      await http().get('/api/payments/mine').set(as(doctorToken)).expect(403);
    });

    it('lists a booking still waiting for payment as pending, a failed attempt as failed, and drops abandoned orders', async () => {
      const waiting = await hold(patientToken, '10:00');
      const failing = await hold(patientToken, '10:15');
      await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_x', order_id: failing.orderId, error_description: 'Card declined' } } } }).expect(200);
      const abandoned = await hold(patientToken, '10:30');
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [abandoned.id]);
      await paymentsService.expireHolds();

      const history = (await http().get('/api/payments/mine').set(as(patientToken)).expect(200)).body as { displayStatus: string; appointment: { id: string } }[];
      const byAppointment = Object.fromEntries(history.map((item) => [item.appointment.id, item.displayStatus]));
      expect(byAppointment[waiting.id]).toBe('PAYMENT_PENDING');
      expect(byAppointment[failing.id]).toBe('PAYMENT_FAILED');
      expect(byAppointment[abandoned.id]).toBeUndefined(); // the hold ran out and nothing was ever paid
    });

    it('gives each record what a receipt needs: doctor, specialty, clinic, the full time range and the payment details', async () => {
      const held = await hold();
      const paymentId = await payFor(held.orderId);
      const [record] = (await http().get('/api/payments/mine').set(as(patientToken)).expect(200)).body;
      expect(record).toMatchObject({
        status: 'PAID',
        displayStatus: 'PAID',
        amountPaise: FEE_PAISE,
        receiptNumber: paymentId,
        orderId: held.orderId,
        refundedPaise: 0,
        appointment: { date: held.date, startTime: '10:00', endTime: '10:15', doctorName: 'Dr. Paid Doctor', specialty: 'ENT', clinicName: 'Test Clinic', clinicAddress: '1 Test St' },
      });
      expect(record.paidAt).toBeTruthy();
      expect(record.createdAt).toBeTruthy();
    });

    it('includes the payment and its refunds on the appointment itself', async () => {
      const held = await hold();
      await payFor(held.orderId);
      const list = (await http().get('/api/appointments/mine').set(as(patientToken)).expect(200)).body;
      expect(list[0].payment).toMatchObject({ displayStatus: 'PAID', amountPaise: FEE_PAISE });
      expect(list[0].holdExpiresAt).toBeNull();
    });
  });

  describe('double-booking protection under concurrency', () => {
    it('lets exactly one of two patients hold the same slot at the same moment', async () => {
      const date = nextDay();
      const results = await Promise.all([book(patientToken, date, '10:00'), book(otherPatientToken, date, '10:00')]);
      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([201, 409]);
      expect(await rows("SELECT 1 FROM appointments WHERE appointment_date = $1 AND start_time = '10:00' AND status IN ('PENDING','CONFIRMED')", [date])).toHaveLength(1);
    });

    it('settles a payment once even when the browser and the webhook arrive together', async () => {
      const held = await hold();
      const body = verifyBody(held.orderId);
      await Promise.all([
        http().post('/api/payments/verify').set(as(patientToken)).send(body),
        webhook(captured(held.orderId, body.razorpayPaymentId)),
        http().post('/api/payments/verify').set(as(patientToken)).send(body),
      ]);
      expect(await status(held.id)).toBe('CONFIRMED');
      expect(await queued(held.id, 'booking-confirmed')).toHaveLength(2);
      expect(await queued(held.id, 'payment-received')).toHaveLength(1);
      expect(await refundsOf(held.id)).toHaveLength(0);
    });

    it('cancelling while the payment lands never leaves a paid booking un-refunded', async () => {
      const held = await hold();
      const body = verifyBody(held.orderId);
      await Promise.all([
        http().post('/api/payments/verify').set(as(patientToken)).send(body),
        http().post(`/api/appointments/${held.id}/cancel`).set(as(patientToken)).send({}),
      ]);
      const appointment = await status(held.id);
      const payment = await paymentOf(held.id);
      if (appointment === 'CANCELLED' && payment.status === 'PAID') expect((await refundsOf(held.id)).length).toBeGreaterThan(0);
      if (appointment === 'CONFIRMED') expect(payment.status).toBe('PAID');
    });
  });

  describe("a patient's notifications and profile", () => {
    it('lists the messages sent about their appointments and the reminders still to come, and nobody else’s', async () => {
      const held = await hold();
      await payFor(held.orderId);
      await notifications.dispatchDue();

      const mine = (await http().get('/api/notifications/mine').set(as(patientToken)).expect(200)).body as { kind: string; status: string; subject: string; appointmentId: string }[];
      const sent = mine.filter((item) => item.status === 'SENT').map((item) => item.kind).sort();
      expect(sent).toEqual(['booking-confirmed', 'payment-received']);
      expect(mine.filter((item) => item.status === 'SCHEDULED').map((item) => item.kind)).toEqual(['reminder', 'reminder']);
      expect(mine.every((item) => item.appointmentId === held.id)).toBe(true);

      expect((await http().get('/api/notifications/mine').set(as(otherPatientToken)).expect(200)).body).toEqual([]);
      await http().get('/api/notifications/mine').expect(401);
      await http().get('/api/notifications/mine').set(as(doctorToken)).expect(403);
    });

    it('leaves out withdrawn reminders and failed deliveries', async () => {
      const held = await hold();
      await payFor(held.orderId);
      await http().post(`/api/appointments/${held.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      await db.query("UPDATE notifications SET status = 'FAILED' WHERE kind = 'payment-received'");
      const mine = (await http().get('/api/notifications/mine').set(as(patientToken)).expect(200)).body as { kind: string; status: string }[];
      expect(mine.some((item) => item.kind === 'reminder')).toBe(false); // cancelled with the appointment
      expect(mine.some((item) => item.kind === 'payment-received')).toBe(false); // failed deliveries are not shown
    });

    it("shows the patient's own details, read only, to patients only", async () => {
      await db.query("UPDATE patients SET phone = '+91 98765 43210', gender = 'Female' WHERE user_id = (SELECT id FROM users WHERE email = 'patient1@test.local')");
      const profile = (await http().get('/api/auth/me/profile').set(as(patientToken)).expect(200)).body;
      expect(profile).toMatchObject({ name: 'Pat One', email: 'patient1@test.local', phone: '+91 98765 43210', gender: 'Female', dateOfBirth: null, address: null });
      expect(profile.memberSince).toBeTruthy();
      expect(JSON.stringify(profile)).not.toMatch(/password|hash/i);
      expect((await http().get('/api/auth/me/profile').set(as(otherPatientToken)).expect(200)).body.email).toBe('patient2@test.local');
      await http().get('/api/auth/me/profile').expect(401);
      await http().get('/api/auth/me/profile').set(as(doctorToken)).expect(403);
    });
  });

  describe('background worker', () => {
    it('runs every job in one pass without error', async () => {
      const held = await hold();
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [held.id]);
      const { JobsService } = await import('../src/jobs/jobs.service.js');
      await app.get(JobsService).runOnce();
      expect(await status(held.id)).toBe('CANCELLED');
      expect(sentTo(/appointment cancelled/i)).toHaveLength(1);
    });
  });
});
