import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DataSource, EntityManager } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EMAIL_SENDER, type EmailMessage } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { DeliveryError, type SendResult } from '../src/notifications/delivery-error.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { DisabledSmsProvider, MockSmsProvider, SMS_PROVIDER } from '../src/notifications/sms-provider.js';
import { PAYMENT_GATEWAY, type GatewayRefund, type PaymentGateway } from '../src/payments/payment-gateway.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
// Test credentials only: they exist nowhere else and unlock nothing.
const KEY_SECRET = 'e2e_razorpay_key_secret';
const WEBHOOK_SECRET = 'e2e_razorpay_webhook_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.REMINDER_HOURS_BEFORE = '24,2';
process.env.REFUND_FULL_HOURS_BEFORE = '24';
process.env.BACKGROUND_JOBS = 'false'; // the tests deliver messages themselves, exactly when they mean to
process.env.NOTIFICATION_MAX_ATTEMPTS = '5';
process.env.NOTIFICATION_RETRY_BASE_SECONDS = '60';
process.env.SMS_DEFAULT_COUNTRY_CODE = '';

const PASSWORD = 'Test@1234';
const FEE_PAISE = 65000;
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
let dayCounter = 0;
const nextDay = () => addDays(today, 3 + (dayCounter++ % 20));

/** Records every email, can be told to fail (all, or just for chosen recipients), and hands back a provider reference like Resend. */
class FakeMailer {
  sent: (EmailMessage & { reference: string })[] = [];
  failure: Error | null = null;
  failTimes = Number.POSITIVE_INFINITY;
  failFor: ((message: EmailMessage) => boolean) | null = null;
  private counter = 0;

  async send(message: EmailMessage): Promise<SendResult> {
    if (this.failure && this.failTimes > 0 && (!this.failFor || this.failFor(message))) {
      this.failTimes -= 1;
      throw this.failure;
    }
    const reference = `msg_${++this.counter}`;
    this.sent.push({ ...message, reference });
    return { reference };
  }

  reset() {
    this.sent = [];
    this.failure = null;
    this.failTimes = Number.POSITIVE_INFINITY;
    this.failFor = null;
  }
}

class FakeGateway implements PaymentGateway {
  readonly enabled = true;
  readonly keyId = 'rzp_test_e2e';
  refundCalls = 0;
  private counter = 0;
  async createOrder(input: { amountPaise: number }) {
    return { id: `order_${++this.counter}`, amountPaise: input.amountPaise, currency: 'INR' };
  }
  async createRefund(input: { amountPaise: number }): Promise<GatewayRefund> {
    this.refundCalls++;
    return { id: `rfnd_${++this.counter}`, status: 'pending', amountPaise: input.amountPaise };
  }
  async fetchRefund(refundId: string): Promise<GatewayRefund> {
    return { id: refundId, status: 'pending', amountPaise: 0 };
  }
  async findRefundByNote(): Promise<GatewayRefund | null> {
    return null;
  }
}

interface Row {
  id: string;
  kind: string;
  channel: string;
  status: string;
  recipient_role: string | null;
  recipient_user_id: string | null;
  to_address: string;
  subject: string;
  body: string;
  attempts: number;
  last_error: string | null;
  provider_reference: string | null;
  sent_at: Date | null;
  last_attempt_at: Date | null;
  send_at: Date;
  dedupe_key: string;
  appointment_id: string;
}

type Private = Record<string, (...args: unknown[]) => Promise<unknown>>;

describe('Appointment notifications (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let notifications: NotificationsService;
  let dataSource: DataSource;
  let paidDoctorId: string;
  let freeDoctorId: string;
  let tokens: Record<string, string> = {};
  let userIds: Record<string, string> = {};
  const mailer = new FakeMailer();
  const sms = new MockSmsProvider();
  const gateway = new FakeGateway();

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (token: string, date: string, startTime: string, doctorId = freeDoctorId) => http().post('/api/appointments').set(as(token)).send({ doctorId, date, startTime });
  const forAppointment = (appointmentId: string, kind?: string) =>
    rows<Row>(`SELECT * FROM notifications WHERE appointment_id = $1 ${kind ? 'AND kind = $2' : ''} ORDER BY recipient_role, channel, created_at`, kind ? [appointmentId, kind] : [appointmentId]);
  const labels = (list: Row[]) => list.map((row) => `${row.recipient_role}/${row.channel}`).sort();
  const pick = (list: Row[], role: string, channel: string) => list.find((row) => row.recipient_role === role && row.channel === channel)!;
  const dispatch = (at = new Date(Date.now() + 1000)) => notifications.dispatchDue(at, 200);

  // ---- paid flow helpers
  const signature = (orderId: string, paymentId: string) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  let paymentCounter = 0;
  /** Books the paid doctor (a held slot), pays for it as the browser would, and returns the appointment and the payment id. */
  const paidBooking = async (token = tokens.patient1, startTime = '10:00', date = nextDay()) => {
    const held = (await book(token, date, startTime, paidDoctorId).expect(201)).body;
    const paymentId = `pay_${++paymentCounter}`;
    await http()
      .post('/api/payments/verify')
      .set(as(token))
      .send({ razorpayOrderId: held.checkout.orderId, razorpayPaymentId: paymentId, razorpaySignature: signature(held.checkout.orderId, paymentId) })
      .expect(200);
    return { id: held.id as string, orderId: held.checkout.orderId as string, paymentId, date };
  };
  const webhook = (event: object, eventId = `evt_${randomUUID()}`) => {
    const raw = JSON.stringify(event);
    return http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'))
      .set('x-razorpay-event-id', eventId)
      .send(raw);
  };
  const refundEvent = (type: string, refundId: string, paymentId: string, amount: number) => ({
    event: type,
    payload: { refund: { entity: { id: refundId, payment_id: paymentId, amount, status: type.replace('refund.', '') } } },
  });
  const paymentFailed = (orderId: string, attemptId: string, description = 'Card declined by the bank') => ({
    event: 'payment.failed',
    payload: { payment: { entity: { id: attemptId, order_id: orderId, error_description: description } } },
  });

  const makeApp = async (smsProvider: MockSmsProvider | DisabledSmsProvider) => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailer)
      .overrideProvider(SMS_PROVIDER)
      .useValue(smsProvider)
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
    const created = moduleRef.createNestApplication<INestApplication<App>>({ rawBody: true });
    configureApp(created);
    await created.init();
    return created;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);

    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) => {
      const id = (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
      userIds[email] = id;
      return id;
    };
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Test Clinic', '1 Test St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string, fee: number) => {
      const id = (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 15, 10, $4) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId, fee],
        )
      ).rows[0].id as string;
      for (let dow = 0; dow < 7; dow++) {
        await db.query("INSERT INTO availability (doctor_id, day_of_week, start_time, end_time, capacity) VALUES ($1, $2, '10:00', '11:00', 6)", [id, dow]);
      }
      return id;
    };
    paidDoctorId = await makeDoctor('Dr. Paid Doctor', 'paid.doctor@test.local', 650);
    freeDoctorId = await makeDoctor('Dr. Free Doctor', 'free.doctor@test.local', 0);
    const patient = async (name: string, email: string, phone: string | null) => {
      const id = await user(name, email, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, phone]);
    };
    await patient('Pat One', 'patient1@test.local', '+91 98765 43210');
    await patient('Pat Two', 'patient2@test.local', null);
    await patient('Pat Three', 'patient3@test.local', '98765 00000'); // no country code, and no default configured
    await user('Admin Person', 'admin@test.local', 'ADMIN');

    app = await makeApp(sms);
    notifications = app.get(NotificationsService);
    dataSource = app.get(DataSource);
    tokens = {
      patient1: await login('patient1@test.local'),
      patient2: await login('patient2@test.local'),
      patient3: await login('patient3@test.local'),
      freeDoctor: await login('free.doctor@test.local'),
      paidDoctor: await login('paid.doctor@test.local'),
      admin: await login('admin@test.local'),
    };
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments;');
    mailer.reset();
    sms.sent.length = 0;
    sms.failWith = null;
    sms.failTimes = Number.POSITIVE_INFINITY;
    gateway.refundCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ================================================================ the events and who is told

  describe('booking confirmation', () => {
    it('emails and texts the patient and emails the doctor, with accurate details and nothing private', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      await dispatch();
      const list = await forAppointment(booked.id, 'booking-confirmed');
      expect(labels(list)).toEqual(['DOCTOR/email', 'PATIENT/email', 'PATIENT/sms']);

      const toPatient = pick(list, 'PATIENT', 'email');
      expect(toPatient.to_address).toBe('patient1@test.local');
      expect(toPatient.subject).toContain('Appointment confirmed: Dr. Free Doctor');
      expect(toPatient.body).toContain('10:15 AM – 10:30 AM');
      expect(toPatient.body).toContain('Test Clinic, 1 Test St');

      const toDoctor = pick(list, 'DOCTOR', 'email');
      expect(toDoctor.to_address).toBe('free.doctor@test.local');
      expect(toDoctor.subject).toMatch(/^New booking: Pat One/);
      expect(toDoctor.body).toContain('Hello Dr. Free Doctor');
      expect(toDoctor.body).toContain('10:15 AM – 10:30 AM');

      const text = pick(list, 'PATIENT', 'sms');
      expect(text.to_address).toBe('+919876543210');
      expect(text.body).toMatch(/^CareSlot: appointment confirmed with Dr\. Free Doctor/);
      expect(text.body.length).toBeLessThanOrEqual(160);
      expect(sms.sent.map((m) => m.to)).toEqual(['+919876543210']);

      // Neither side is given the other's contact details.
      expect(toDoctor.body).not.toMatch(/patient1@test\.local|98765/);
      expect(toPatient.body).not.toMatch(/free\.doctor@test\.local/);
      for (const row of list) expect(row.body).not.toMatch(/password|token|hash/i);
    });

    it('sends no text, and does not fail, when the patient has no usable phone number', async () => {
      for (const token of [tokens.patient2, tokens.patient3]) {
        const booked = (await book(token, nextDay(), '10:00').expect(201)).body;
        await dispatch();
        const list = await forAppointment(booked.id, 'booking-confirmed');
        expect(labels(list)).toEqual(['DOCTOR/email', 'PATIENT/email']); // patient 3's number has no country code, so it is not guessed
      }
      expect(sms.sent).toHaveLength(0);
    });
  });

  describe('cancellation', () => {
    it('tells the patient and the doctor when the patient cancels', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(tokens.patient1)).send({ reason: 'Plans changed' }).expect(200);
      await dispatch();
      const list = await forAppointment(booked.id, 'booking-cancelled');
      expect(labels(list)).toEqual(['DOCTOR/email', 'PATIENT/email', 'PATIENT/sms']);
      expect(pick(list, 'PATIENT', 'email').body).toContain('cancelled by you');
      expect(pick(list, 'PATIENT', 'email').body).toContain('Plans changed');
      expect(pick(list, 'DOCTOR', 'email').subject).toMatch(/^Booking cancelled: Pat One/);
      expect(pick(list, 'DOCTOR', 'email').body).toContain('Pat One cancelled');
      expect(pick(list, 'PATIENT', 'sms').body).toContain('was cancelled');
    });

    it('tells both of them, with the reason, when the doctor cancels', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      await http().post(`/api/doctor-portal/appointments/${booked.id}/cancel`).set(as(tokens.freeDoctor)).send({ reason: 'Emergency surgery' }).expect(200);
      await dispatch();
      const list = await forAppointment(booked.id, 'booking-cancelled');
      expect(labels(list)).toEqual(['DOCTOR/email', 'PATIENT/email', 'PATIENT/sms']);
      expect(pick(list, 'PATIENT', 'email').body).toContain('cancelled by the doctor');
      expect(pick(list, 'PATIENT', 'email').body).toContain('Emergency surgery');
      expect(pick(list, 'DOCTOR', 'email').body).toContain('You cancelled');
      expect(pick(list, 'PATIENT', 'sms').body).toContain('by the doctor');
    });

    it('tells the patient when an unpaid booking is released because payment ran out of time', async () => {
      const held = (await book(tokens.patient1, nextDay(), '10:00', paidDoctorId).expect(201)).body;
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [held.id]);
      const { PaymentsService } = await import('../src/payments/payments.service.js');
      await app.get(PaymentsService).expireHolds();
      await dispatch();
      const list = await forAppointment(held.id, 'booking-cancelled');
      expect(pick(list, 'PATIENT', 'email').body).toContain('payment was not completed in time');
    });
  });

  describe('rescheduling', () => {
    it('gives the patient and the doctor the old and the new details', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:00').expect(201)).body;
      const moved = (await http().post(`/api/appointments/${booked.id}/reschedule`).set(as(tokens.patient1)).send({ date, startTime: '10:30' }).expect(201)).body;
      await dispatch();
      const list = await forAppointment(moved.id, 'booking-rescheduled');
      expect(labels(list)).toEqual(['DOCTOR/email', 'PATIENT/email', 'PATIENT/sms']);
      for (const row of list.filter((entry) => entry.channel === 'email')) {
        expect(row.body).toContain('10:00 AM – 10:15 AM'); // where it was
        expect(row.body).toContain('10:30 AM – 10:45 AM'); // where it is now
      }
      expect(pick(list, 'DOCTOR', 'email').subject).toMatch(/^Booking rescheduled: Pat One/);
      expect(pick(list, 'PATIENT', 'sms').body).toContain('10:30 AM – 10:45 AM');
      // The reminders follow the appointment: the old ones are withdrawn, new ones exist.
      expect((await forAppointment(booked.id, 'reminder')).every((row) => row.status === 'CANCELLED')).toBe(true);
      expect((await forAppointment(moved.id, 'reminder')).filter((row) => row.status === 'SENT' || row.status === 'PENDING')).toHaveLength(4); // two intervals, by email and by text
    });
  });

  describe('payments', () => {
    it('sends the patient a receipt by email and text on success, and tells the doctor about the confirmed booking', async () => {
      const booking = await paidBooking();
      await dispatch();
      const receipts = await forAppointment(booking.id, 'payment-received');
      expect(labels(receipts)).toEqual(['PATIENT/email', 'PATIENT/sms']);
      expect(pick(receipts, 'PATIENT', 'email').body).toContain(`Receipt: ${booking.paymentId}`);
      expect(pick(receipts, 'PATIENT', 'email').body).toContain('Rs. 650.00');
      expect(pick(receipts, 'PATIENT', 'sms').body).toContain(booking.paymentId);
      // The doctor's notice is the booking confirmation, which a paid booking sends only once the payment has gone through.
      expect(labels(await forAppointment(booking.id, 'booking-confirmed'))).toEqual(['DOCTOR/email', 'PATIENT/email', 'PATIENT/sms']);
    });

    it('sends no confirmation to anyone while a booking is only held for payment', async () => {
      const held = (await book(tokens.patient1, nextDay(), '10:00', paidDoctorId).expect(201)).body;
      await dispatch();
      expect(await forAppointment(held.id)).toHaveLength(0);
    });

    it('tells the patient when a payment fails, with the reason, so they can try again', async () => {
      const held = (await book(tokens.patient1, nextDay(), '10:00', paidDoctorId).expect(201)).body;
      await webhook(paymentFailed(held.checkout.orderId, 'pay_attempt_1')).expect(200);
      await dispatch();
      const list = await forAppointment(held.id, 'payment-failed');
      expect(labels(list)).toEqual(['PATIENT/email', 'PATIENT/sms']);
      expect(pick(list, 'PATIENT', 'email').body).toContain('did not go through');
      expect(pick(list, 'PATIENT', 'email').body).toContain('Card declined by the bank');
      expect(pick(list, 'PATIENT', 'sms').body).toContain('failed');
    });

    it('reports each failed attempt once: a repeated event is ignored, and a new attempt is reported', async () => {
      const held = (await book(tokens.patient1, nextDay(), '10:00', paidDoctorId).expect(201)).body;
      await webhook(paymentFailed(held.checkout.orderId, 'pay_attempt_1')).expect(200);
      await webhook(paymentFailed(held.checkout.orderId, 'pay_attempt_1')).expect(200); // same attempt, different event id
      expect(await forAppointment(held.id, 'payment-failed')).toHaveLength(2); // one email and one text
      await webhook(paymentFailed(held.checkout.orderId, 'pay_attempt_2')).expect(200);
      expect(await forAppointment(held.id, 'payment-failed')).toHaveLength(4);
    });

    it('does not report a failure for a payment that already succeeded or whose hold ended', async () => {
      const paid = await paidBooking();
      await webhook(paymentFailed(paid.orderId, 'pay_late_failure')).expect(200);
      expect(await forAppointment(paid.id, 'payment-failed')).toHaveLength(0);

      const held = (await book(tokens.patient1, nextDay(), '10:15', paidDoctorId).expect(201)).body;
      await db.query("UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [held.id]);
      const { PaymentsService } = await import('../src/payments/payments.service.js');
      await app.get(PaymentsService).expireHolds();
      await webhook(paymentFailed(held.checkout.orderId, 'pay_after_expiry')).expect(200);
      expect(await forAppointment(held.id, 'payment-failed')).toHaveLength(0);
    });
  });

  describe('refunds', () => {
    it('tells the patient when a refund is initiated, processed, and when one fails', async () => {
      const first = await paidBooking(tokens.patient1, '10:00');
      await http().post(`/api/appointments/${first.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      await dispatch();
      const initiated = await forAppointment(first.id, 'refund-pending');
      expect(labels(initiated)).toEqual(['PATIENT/email', 'PATIENT/sms']);
      expect(pick(initiated, 'PATIENT', 'email').subject).toMatch(/^Refund started: Rs\. 650\.00/);
      expect(pick(initiated, 'PATIENT', 'email').body).toContain('has been started');
      expect(pick(initiated, 'PATIENT', 'sms').body).toContain('has been started');

      const [refund] = await rows<{ razorpay_refund_id: string }>('SELECT r.razorpay_refund_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.appointment_id = $1', [first.id]);
      await webhook(refundEvent('refund.processed', refund.razorpay_refund_id, first.paymentId, FEE_PAISE)).expect(200);
      await dispatch();
      const processed = await forAppointment(first.id, 'refund-processed');
      expect(labels(processed)).toEqual(['PATIENT/email', 'PATIENT/sms']);
      expect(pick(processed, 'PATIENT', 'email').body).toContain('has been processed');

      const second = await paidBooking(tokens.patient1, '10:15');
      await http().post(`/api/appointments/${second.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      const [other] = await rows<{ razorpay_refund_id: string }>('SELECT r.razorpay_refund_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.appointment_id = $1', [second.id]);
      await webhook(refundEvent('refund.failed', other.razorpay_refund_id, second.paymentId, FEE_PAISE)).expect(200);
      await dispatch();
      const failed = await forAppointment(second.id, 'refund-failed');
      expect(labels(failed)).toEqual(['PATIENT/email', 'PATIENT/sms']);
      expect(pick(failed, 'PATIENT', 'email').body).toContain('could not be completed');
    });

    it('does not tell the doctor about money: refunds are the patient’s business', async () => {
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      const list = await forAppointment(booking.id);
      expect(list.filter((row) => row.recipient_role === 'DOCTOR').map((row) => row.kind).sort()).toEqual(['booking-cancelled', 'booking-confirmed']);
    });
  });

  // ================================================================ tracking

  describe('tracking', () => {
    it('records the type, recipient, channel, status, timestamps and the provider reference of every message', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      const before = await forAppointment(booked.id, 'booking-confirmed');
      expect(before.every((row) => row.status === 'PENDING' && row.attempts === 0 && row.sent_at === null && row.provider_reference === null)).toBe(true);
      expect(mailer.sent).toHaveLength(0); // the booking response did not wait for any delivery

      await dispatch();
      const after = await forAppointment(booked.id, 'booking-confirmed');
      for (const row of after) {
        expect(row).toMatchObject({ kind: 'booking-confirmed', status: 'SENT', attempts: 1, last_error: null });
        expect(row.sent_at).toBeInstanceOf(Date);
        expect(row.last_attempt_at).toBeInstanceOf(Date);
        expect(row.appointment_id).toBe(booked.id);
      }
      expect(pick(after, 'PATIENT', 'email')).toMatchObject({ recipient_user_id: userIds['patient1@test.local'], to_address: 'patient1@test.local' });
      expect(pick(after, 'DOCTOR', 'email')).toMatchObject({ recipient_user_id: userIds['free.doctor@test.local'], to_address: 'free.doctor@test.local' });
      expect(pick(after, 'PATIENT', 'email').provider_reference).toMatch(/^msg_\d+$/);
      expect(pick(after, 'PATIENT', 'sms').provider_reference).toMatch(/^mock-sms-\d+$/);
    });
  });

  // ================================================================ retries, failures and monitoring

  describe('retries and failures', () => {
    const patientEmail = async (appointmentId: string) => pick(await forAppointment(appointmentId, 'booking-confirmed'), 'PATIENT', 'email');
    const book1 = async () => (await book(tokens.patient2, nextDay(), '10:00').expect(201)).body.id as string;

    it('waits longer after each failed attempt: 1, 2, 4, 8 minutes, then delivers once the provider recovers', async () => {
      const id = await book1();
      mailer.failure = new DeliveryError('Resend responded with HTTP 503', true);
      mailer.failFor = (message) => message.to === 'patient2@test.local';
      const start = Date.now() + 1000;
      let now = new Date(start);
      for (const wait of [60, 120, 240, 480]) {
        await dispatch(now);
        const row = await patientEmail(id);
        expect(row.status).toBe('PENDING');
        expect(row.send_at.getTime()).toBe(now.getTime() + wait * 1000);
        expect(row.last_error).toContain('HTTP 503');
        now = new Date(row.send_at.getTime());
      }
      expect((await patientEmail(id)).attempts).toBe(4);

      mailer.reset(); // the provider recovers
      await dispatch(now);
      const done = await patientEmail(id);
      expect(done).toMatchObject({ status: 'SENT', attempts: 5, last_error: null });
      expect(done.provider_reference).toMatch(/^msg_/);
    });

    it('does not send a message before its retry time', async () => {
      const id = await book1();
      mailer.failure = new DeliveryError('down', true);
      mailer.failFor = (message) => message.to === 'patient2@test.local';
      const now = new Date(Date.now() + 1000);
      await dispatch(now);
      mailer.reset();
      await dispatch(new Date(now.getTime() + 30_000)); // only half a minute later: not due yet
      expect((await patientEmail(id)).status).toBe('PENDING');
      await dispatch(new Date(now.getTime() + 61_000));
      expect((await patientEmail(id)).status).toBe('SENT');
    });

    it('gives up after the maximum number of attempts but keeps the record, with its error', async () => {
      const id = await book1();
      mailer.failure = new DeliveryError('Resend responded with HTTP 500', true);
      mailer.failFor = (message) => message.to === 'patient2@test.local';
      let now = new Date(Date.now() + 1000);
      for (let attempt = 1; attempt <= 5; attempt++) {
        await dispatch(now);
        now = new Date(now.getTime() + 3600 * 1000 + 1000);
      }
      const row = await patientEmail(id);
      expect(row).toMatchObject({ status: 'FAILED', attempts: 5 });
      expect(row.last_error).toContain('HTTP 500');
      await dispatch(now); // nothing more is tried
      expect((await patientEmail(id)).attempts).toBe(5);
    });

    it('does not retry a permanent refusal such as the Resend 403, and keeps the provider’s reason', async () => {
      const id = await book1();
      mailer.failure = new DeliveryError(
        'Resend responded with HTTP 403 (validation_error: You can only send testing emails to your own email address.)',
        false,
        'validation_error',
      );
      mailer.failFor = (message) => message.to === 'patient2@test.local';
      await dispatch();
      const row = await patientEmail(id);
      expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(row.last_error).toContain('HTTP 403');
      expect(row.last_error).toContain('validation_error');
    });

    it('treats an unexpected error as temporary rather than giving up on a guess', async () => {
      const id = await book1();
      mailer.failure = new Error('socket hang up');
      mailer.failFor = (message) => message.to === 'patient2@test.local';
      await dispatch();
      expect(await patientEmail(id)).toMatchObject({ status: 'PENDING', attempts: 1 });
    });

    it('lets one failing message leave the others alone: the doctor’s email and the text still go out', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      mailer.failure = new DeliveryError('refused', false);
      mailer.failFor = (message) => message.to === 'patient1@test.local';
      const result = await dispatch();
      expect(result.failed).toBe(1);
      const list = await forAppointment(booked.id, 'booking-confirmed');
      expect(pick(list, 'PATIENT', 'email').status).toBe('FAILED');
      expect(pick(list, 'DOCTOR', 'email').status).toBe('SENT');
      expect(pick(list, 'PATIENT', 'sms').status).toBe('SENT');
    });

    it('retries a text that failed temporarily with the same backoff, and fails a refused one at once', async () => {
      const first = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      sms.failWith = new DeliveryError('Twilio responded with HTTP 503', true);
      sms.failTimes = 1;
      const now = new Date(Date.now() + 1000);
      await dispatch(now);
      let text = pick(await forAppointment(first.id, 'booking-confirmed'), 'PATIENT', 'sms');
      expect(text).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(text.send_at.getTime()).toBe(now.getTime() + 60_000);
      await dispatch(new Date(now.getTime() + 61_000));
      text = pick(await forAppointment(first.id, 'booking-confirmed'), 'PATIENT', 'sms');
      expect(text).toMatchObject({ status: 'SENT', attempts: 2 });
      expect(text.provider_reference).toMatch(/^mock-sms-/);

      const second = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      sms.failWith = new DeliveryError("Twilio responded with HTTP 400 (21211: The 'To' number is not a valid phone number.)", false, '21211');
      sms.failTimes = Number.POSITIVE_INFINITY;
      await dispatch();
      text = pick(await forAppointment(second.id, 'booking-confirmed'), 'PATIENT', 'sms');
      expect(text).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(text.last_error).toContain('21211');
    });

    it('lets an administrator list failed deliveries and put one back in the queue, once', async () => {
      const id = await book1();
      mailer.failure = new DeliveryError('Resend responded with HTTP 403 (validation_error: not allowed)', false, 'validation_error');
      mailer.failFor = (message) => message.to === 'patient2@test.local';
      await dispatch();
      const failed = await patientEmail(id);
      expect(failed.status).toBe('FAILED');

      const list = (await http().get('/api/notifications/admin/failed').set(as(tokens.admin)).expect(200)).body as Record<string, unknown>[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: failed.id, kind: 'booking-confirmed', channel: 'email', recipientRole: 'PATIENT', to: 'patient2@test.local', attempts: 1, appointmentId: id });
      expect(String(list[0].lastError)).toContain('403');
      expect(list[0]).not.toHaveProperty('body'); // a monitoring list does not need the message text

      mailer.reset(); // the problem is fixed (for example the sender domain is now verified)
      await http().post(`/api/notifications/admin/${failed.id}/retry`).set(as(tokens.admin)).expect(200);
      expect(await patientEmail(id)).toMatchObject({ status: 'PENDING', attempts: 0 });
      await dispatch();
      expect(await patientEmail(id)).toMatchObject({ status: 'SENT', attempts: 1 });

      // A message that was sent is never sent again, and an unknown one is a clear 404.
      await http().post(`/api/notifications/admin/${failed.id}/retry`).set(as(tokens.admin)).expect(404);
      await http().post(`/api/notifications/admin/${randomUUID()}/retry`).set(as(tokens.admin)).expect(404);
      await http().post('/api/notifications/admin/not-a-uuid/retry').set(as(tokens.admin)).expect(400);
      expect(mailer.sent.filter((message) => message.to === 'patient2@test.local')).toHaveLength(1);
    });

    it('keeps the monitoring endpoints for administrators only', async () => {
      for (const token of [tokens.patient1, tokens.freeDoctor]) {
        await http().get('/api/notifications/admin/failed').set(as(token)).expect(403);
        await http().post(`/api/notifications/admin/${randomUUID()}/retry`).set(as(token)).expect(403);
      }
      await http().get('/api/notifications/admin/failed').expect(401);
    });
  });

  // ================================================================ duplicates

  describe('duplicate events', () => {
    const replay = (appointmentId: string) => dataSource.transaction((manager: EntityManager) => notifications.bookingConfirmed(manager, appointmentId));

    it('never queues the same message twice when an event is replayed', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      const before = (await forAppointment(booked.id)).length;
      await replay(booked.id);
      await replay(booked.id);
      expect((await forAppointment(booked.id)).length).toBe(before);
      await dispatch();
      await replay(booked.id); // even after the first copies were sent
      await dispatch();
      expect(mailer.sent.filter((message) => message.subject.startsWith('Appointment confirmed'))).toHaveLength(1);
      expect(sms.sent).toHaveLength(1);
    });

    it('keeps the message keys stable, so messages queued before doctors and texts existed are never repeated', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      const keys = (await forAppointment(booked.id, 'booking-confirmed')).map((row) => row.dedupe_key).sort();
      expect(keys).toEqual([`booking-confirmed:${booked.id}`, `booking-confirmed:${booked.id}:doctor`, `booking-confirmed:${booked.id}:sms`].sort());
    });

    it('does not repeat a payment or refund message when the provider redelivers the event', async () => {
      const booking = await paidBooking();
      const count = async () => (await forAppointment(booking.id)).length;
      const before = await count();
      const captured = { event: 'payment.captured', payload: { payment: { entity: { id: booking.paymentId, order_id: booking.orderId, amount: FEE_PAISE, currency: 'INR' } } } };
      await webhook(captured, 'evt_one').expect(200);
      await webhook(captured, 'evt_two').expect(200); // a different event id for the same payment
      await webhook({ ...captured, event: 'order.paid' }, 'evt_three').expect(200);
      expect(await count()).toBe(before);
    });
  });

  // ================================================================ isolation from the booking, payment and refund flows

  describe('failure isolation', () => {
    const sabotage = (name: string, behaviour: (manager: EntityManager) => Promise<unknown>) =>
      vi.spyOn(notifications as unknown as Private, name).mockImplementationOnce(behaviour as never);

    it('still books when building the notification fails', async () => {
      const spy = sabotage('load', async () => {
        throw new Error('boom: could not load the appointment');
      });
      const response = await book(tokens.patient1, nextDay(), '10:00').expect(201);
      expect(spy).toHaveBeenCalled();
      expect(response.body.status).toBe('CONFIRMED');
      expect(await forAppointment(response.body.id)).toHaveLength(0);
      // ...and the next booking is notified normally.
      const next = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      expect((await forAppointment(next.id, 'booking-confirmed')).length).toBe(3);
    });

    it('still books when a database error happens while queueing: the booking transaction is not poisoned', async () => {
      sabotage('load', async (manager) => {
        await manager.query('SELECT 1/0'); // a real database error: it would abort the whole transaction without the savepoint
      });
      const response = await book(tokens.patient1, nextDay(), '10:00').expect(201);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [response.body.id])).toEqual([{ status: 'CONFIRMED' }]);
    });

    it('still books when writing the message itself is rejected by the database', async () => {
      sabotage('enqueue', async (manager) => {
        await manager.query("INSERT INTO notifications (channel, kind, to_address, subject, body, dedupe_key) VALUES ('pigeon', 'x', 'a', 'b', 'c', 'k')"); // breaks ck_notifications_channel
      });
      const response = await book(tokens.patient1, nextDay(), '10:00').expect(201);
      expect(response.body.status).toBe('CONFIRMED');
      expect(await forAppointment(response.body.id)).toHaveLength(0);
    });

    it('still confirms and records a payment when its notifications cannot be queued', async () => {
      const held = (await book(tokens.patient1, nextDay(), '10:00', paidDoctorId).expect(201)).body;
      vi.spyOn(notifications as unknown as Private, 'load').mockRejectedValue(new Error('boom'));
      const paymentId = 'pay_isolation';
      await http()
        .post('/api/payments/verify')
        .set(as(tokens.patient1))
        .send({ razorpayOrderId: held.checkout.orderId, razorpayPaymentId: paymentId, razorpaySignature: signature(held.checkout.orderId, paymentId) })
        .expect(200);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [held.id])).toEqual([{ status: 'CONFIRMED' }]);
      expect(await rows('SELECT status, razorpay_payment_id FROM payments WHERE appointment_id = $1', [held.id])).toEqual([{ status: 'PAID', razorpay_payment_id: paymentId }]);
      expect(await forAppointment(held.id)).toHaveLength(0);
    });

    it('still cancels, and still creates and sends the refund, when notifications cannot be queued', async () => {
      const booking = await paidBooking();
      vi.spyOn(notifications as unknown as Private, 'load').mockRejectedValue(new Error('boom'));
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [booking.id])).toEqual([{ status: 'CANCELLED' }]);
      const refunds = await rows<{ status: string; razorpay_refund_id: string | null }>('SELECT r.status, r.razorpay_refund_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.appointment_id = $1', [booking.id]);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].razorpay_refund_id).toBeTruthy();
      expect(gateway.refundCalls).toBe(1);
    });

    it('still records a failed payment when its notice cannot be queued', async () => {
      const held = (await book(tokens.patient1, nextDay(), '10:00', paidDoctorId).expect(201)).body;
      vi.spyOn(notifications as unknown as Private, 'load').mockRejectedValue(new Error('boom'));
      await webhook(paymentFailed(held.checkout.orderId, 'pay_attempt_x')).expect(200);
      expect(await rows('SELECT status FROM payments WHERE appointment_id = $1', [held.id])).toEqual([{ status: 'FAILED' }]);
    });

    it('does not let a total email outage touch bookings, payments or refunds: messages simply wait', async () => {
      mailer.failure = new DeliveryError('Resend responded with HTTP 503', true);
      sms.failWith = new DeliveryError('Twilio responded with HTTP 503', true);
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      await dispatch();
      const list = await forAppointment(booking.id);
      const live = list.filter((row) => row.status !== 'CANCELLED'); // (the reminders were withdrawn by the cancellation)
      expect(live.length).toBeGreaterThan(5);
      expect(live.every((row) => row.status === 'PENDING' && row.attempts === 1)).toBe(true); // all kept, all waiting for a retry
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [booking.id])).toEqual([{ status: 'CANCELLED' }]);
      expect(await rows('SELECT status FROM payments WHERE appointment_id = $1', [booking.id])).toEqual([{ status: 'PAID' }]);
      expect(gateway.refundCalls).toBe(1);

      mailer.reset();
      sms.failWith = null;
      await dispatch(new Date(Date.now() + 120_000)); // the providers recover: everything is delivered
      expect((await forAppointment(booking.id)).every((row) => row.status === 'SENT' || row.status === 'CANCELLED')).toBe(true);
    });
  });

  // ================================================================ what the patient sees in the app

  describe('the in-app notification list', () => {
    it('lists only the patient’s own emails: not the doctor’s copies, not the text duplicates, not another patient’s', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:00').expect(201)).body;
      await book(tokens.patient2, nextDay(), '10:00').expect(201);
      await dispatch();
      const mine = (await http().get('/api/notifications/mine').set(as(tokens.patient1)).expect(200)).body as { kind: string; subject: string; status: string; appointmentId: string }[];
      expect(mine.filter((item) => item.status === 'SENT').map((item) => item.kind)).toEqual(['booking-confirmed']);
      expect(mine.every((item) => item.appointmentId === booked.id)).toBe(true);
      expect(mine.some((item) => item.subject.startsWith('New booking'))).toBe(false); // the doctor's copy
      // The patient has a phone, so each of the two reminders (24 hours and 1 hour before) is scheduled by email and by text.
      expect(mine.filter((item) => item.status === 'SCHEDULED').map((item) => item.kind)).toEqual(['reminder', 'reminder', 'reminder', 'reminder']);
      await http().get('/api/notifications/mine').set(as(tokens.freeDoctor)).expect(403);
    });

    it('still shows the payment and refund messages the patient has always had', async () => {
      const booking = await paidBooking();
      await http().post(`/api/appointments/${booking.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      await dispatch();
      const kinds = ((await http().get('/api/notifications/mine').set(as(tokens.patient1)).expect(200)).body as { kind: string }[]).map((item) => item.kind);
      for (const kind of ['booking-confirmed', 'payment-received', 'booking-cancelled', 'refund-pending']) expect(kinds).toContain(kind);
    });
  });
});

// ==================================================================== SMS not configured

describe('Appointment notifications without SMS credentials (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  const mailer = new FakeMailer();

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailer)
      .overrideProvider(SMS_PROVIDER)
      .useValue(new DisabledSmsProvider()) // what the app builds when no Twilio credentials are set
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ rawBody: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('books normally, queues only emails, queues no text at all, and never fails because SMS is missing', async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments;');
    const login = async (email: string) =>
      (await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
    const token = await login('patient1@test.local'); // has a valid phone number
    const doctorId = (await db.query("SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.email = 'free.doctor@test.local'")).rows[0].id as string;
    const booked = await request(app.getHttpServer()).post('/api/appointments').set('Authorization', `Bearer ${token}`).send({ doctorId, date: nextDay(), startTime: '10:00' }).expect(201);
    expect(booked.body.status).toBe('CONFIRMED');
    const channels = (await db.query('SELECT DISTINCT channel FROM notifications WHERE appointment_id = $1', [booked.body.id])).rows.map((row) => row.channel);
    expect(channels).toEqual(['email']);
    const result = await app.get(NotificationsService).dispatchDue(new Date(Date.now() + 1000), 100);
    expect(result.failed).toBe(0);
    expect(mailer.sent.length).toBeGreaterThanOrEqual(2); // the patient's and the doctor's email
  });
});
