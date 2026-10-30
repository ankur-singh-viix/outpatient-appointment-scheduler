import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EMAIL_SENDER, type EmailMessage } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { DeliveryError, type SendResult } from '../src/notifications/delivery-error.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { MockSmsProvider, SMS_PROVIDER } from '../src/notifications/sms-provider.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.BACKGROUND_JOBS = 'false'; // the tests run the worker themselves, exactly when they mean to
process.env.CLINIC_TIMEZONE = 'Asia/Kolkata'; // IST: UTC+05:30, no daylight saving
process.env.REMINDER_HOURS_BEFORE = '24,1';
process.env.NOTIFICATION_MAX_ATTEMPTS = '5';
process.env.NOTIFICATION_RETRY_BASE_SECONDS = '60';
process.env.SMS_DEFAULT_COUNTRY_CODE = '';

const PASSWORD = 'Test@1234';
const today = clinicNow('Asia/Kolkata').date;
let dayCounter = 0;
const nextDay = () => addDays(today, 4 + (dayCounter++ % 18));
const HOUR = 3_600_000;

/** The real instant of an IST wall-clock time: reminderAt('2026-11-05', '10:15', 24) is 24 real hours before 10:15 IST that day. */
const startOf = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`).getTime();
const reminderAt = (date: string, time: string, hoursBefore: number) => new Date(startOf(date, time) - hoursBefore * HOUR);

class FakeMailer {
  sent: (EmailMessage & { reference: string })[] = [];
  failure: Error | null = null;
  failTimes = Number.POSITIVE_INFINITY;
  private counter = 0;
  async send(message: EmailMessage): Promise<SendResult> {
    if (this.failure && this.failTimes > 0) {
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
  }
}

interface Row {
  id: string;
  kind: string;
  channel: string;
  category: string;
  status: string;
  recipient_role: string | null;
  to_address: string;
  subject: string;
  body: string;
  attempts: number;
  last_error: string | null;
  send_at: Date;
  dedupe_key: string;
  appointment_id: string;
}

describe('Appointment reminders and notification preferences (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let notifications: NotificationsService;
  let dataSource: DataSource;
  let doctorId: string;
  let tokens: Record<string, string> = {};
  const mailer = new FakeMailer();
  const sms = new MockSmsProvider();

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (token: string, date: string, startTime: string) => http().post('/api/appointments').set(as(token)).send({ doctorId, date, startTime });
  const reminders = (appointmentId: string) =>
    rows<Row>("SELECT * FROM notifications WHERE appointment_id = $1 AND kind = 'reminder' ORDER BY send_at, channel", [appointmentId]);
  const live = async (appointmentId: string) => (await reminders(appointmentId)).filter((row) => row.status === 'PENDING' || row.status === 'SENT');
  const dispatch = (at = new Date(Date.now() + 1000)) => notifications.dispatchDue(at, 200);
  /** Makes every reminder of an appointment due now, as if its time had come. */
  const makeDue = (appointmentId: string) => db.query("UPDATE notifications SET send_at = now() - interval '1 minute' WHERE appointment_id = $1 AND kind = 'reminder' AND status = 'PENDING'", [appointmentId]);
  const reminderMails = () => mailer.sent.filter((message) => message.subject.startsWith('Reminder:'));
  const setStatus = (id: string, status: string) =>
    db.query(
      status === 'CANCELLED'
        ? "UPDATE appointments SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = booked_by_user_id WHERE id = $1"
        : `UPDATE appointments SET status = '${status}' WHERE id = $1`,
      [id],
    );
  const prefs = (token: string) => http().get('/api/notifications/preferences').set(as(token));
  const setPrefs = (token: string, body: object) => http().put('/api/notifications/preferences').set(as(token)).send(body);

  const makeApp = async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailer)
      .overrideProvider(SMS_PROVIDER)
      .useValue(sms)
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
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Test Clinic', '1 Test St') RETURNING id")).rows[0].id as string;
    doctorId = (
      await db.query(
        `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 15, 10, 0) RETURNING id`,
        [await user('Dr. Free Doctor', 'doctor@test.local', 'DOCTOR'), clinicId, specialtyId],
      )
    ).rows[0].id as string;
    for (let dow = 0; dow < 7; dow++) {
      await db.query("INSERT INTO availability (doctor_id, day_of_week, start_time, end_time, capacity) VALUES ($1, $2, '10:00', '12:00', 20)", [doctorId, dow]);
    }
    for (const [name, email, phone] of [
      ['Pat One', 'patient1@test.local', '+91 98765 43210'],
      ['Pat Two', 'patient2@test.local', null],
    ] as const) {
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [await user(name, email, 'PATIENT'), phone]);
    }

    app = await makeApp();
    notifications = app.get(NotificationsService);
    dataSource = app.get(DataSource);
    tokens = { patient1: await login('patient1@test.local'), patient2: await login('patient2@test.local'), doctor: await login('doctor@test.local') };
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments; DELETE FROM notification_preferences;');
    mailer.reset();
    sms.sent.length = 0;
    sms.failWith = null;
    sms.failTimes = Number.POSITIVE_INFINITY;
  });

  // ================================================================ scheduling

  describe('scheduling after a booking', () => {
    it('sets a reminder 24 hours and 1 hour before the appointment, in IST, by email and text', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      const list = await reminders(booked.id);
      expect(list.map((row) => `${row.channel}@${row.send_at.toISOString()}`).sort()).toEqual(
        [
          `email@${reminderAt(date, '10:15', 24).toISOString()}`,
          `sms@${reminderAt(date, '10:15', 24).toISOString()}`,
          `email@${reminderAt(date, '10:15', 1).toISOString()}`,
          `sms@${reminderAt(date, '10:15', 1).toISOString()}`,
        ].sort(),
      );
      // 10:15 IST is 04:45 UTC: the 1-hour reminder is at 09:15 IST = 03:45 UTC, the 24-hour one the previous day at 04:45 UTC.
      expect(reminderAt(date, '10:15', 1).toISOString().slice(11, 16)).toBe('03:45');
      for (const row of list) {
        expect(row).toMatchObject({ kind: 'reminder', category: 'reminder', status: 'PENDING', recipient_role: 'PATIENT', attempts: 0 });
      }
      expect(list.filter((row) => row.channel === 'sms').every((row) => row.to_address === '+919876543210')).toBe(true);
    });

    it('sends reminders to the patient only, and texts only a patient with a usable number', async () => {
      const booked = (await book(tokens.patient2, nextDay(), '10:15').expect(201)).body;
      const list = await reminders(booked.id);
      expect(list.map((row) => row.channel)).toEqual(['email', 'email']);
      expect(list.every((row) => row.recipient_role === 'PATIENT' && row.to_address === 'patient2@test.local')).toBe(true);
    });

    it('does not schedule an interval whose moment has already passed', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      await db.query('DELETE FROM notifications WHERE appointment_id = $1', [booked.id]);
      // Pretend the booking is confirmed at noon IST the day before: the 24-hour moment (04:45 UTC the day before) is gone.
      const noonBefore = new Date(startOf(addDays(date, -1), '12:00'));
      await dataSource.transaction((manager) => notifications.bookingConfirmed(manager, booked.id, noonBefore));
      expect((await reminders(booked.id)).map((row) => row.send_at.toISOString())).toEqual([reminderAt(date, '10:15', 1).toISOString(), reminderAt(date, '10:15', 1).toISOString()]);
      // ...and inside the last hour nothing is left to schedule.
      await db.query('DELETE FROM notifications WHERE appointment_id = $1', [booked.id]);
      await dataSource.transaction((manager) => notifications.bookingConfirmed(manager, booked.id, new Date(startOf(date, '09:30'))));
      expect(await reminders(booked.id)).toHaveLength(0);
    });

    it('does not use the server’s time zone: the same appointment gets the same moments whatever the host clock says', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '11:00').expect(201)).body;
      const first = (await reminders(booked.id)).find((row) => row.channel === 'email' && row.send_at.getTime() === reminderAt(date, '11:00', 1).getTime());
      expect(first).toBeDefined(); // 11:00 IST - 1h = 10:00 IST = 04:30 UTC, regardless of where the server runs
      expect(first!.send_at.toISOString().slice(11, 16)).toBe('04:30');
    });
  });

  // ================================================================ delivery and the last-moment check

  describe('delivery', () => {
    it('delivers each due reminder once, by email and text, with the real details', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      await dispatch(); // the booking confirmations; the reminders are not due yet
      expect(reminderMails()).toHaveLength(0);
      mailer.reset();
      sms.sent.length = 0;

      await makeDue(booked.id);
      const result = await dispatch();
      expect(result.sent).toBe(4);
      expect(reminderMails()).toHaveLength(2);
      expect(sms.sent.filter((message) => message.body.startsWith('CareSlot reminder'))).toHaveLength(2);
      const mail = reminderMails()[0];
      expect(mail.to).toBe('patient1@test.local');
      expect(mail.text).toContain('Dr. Free Doctor');
      expect(mail.text).toContain('10:15 AM – 10:30 AM');
      expect(mail.text).toContain('Test Clinic, 1 Test St');
      expect((await live(booked.id)).every((row) => row.status === 'SENT')).toBe(true);

      await dispatch(); // nothing is sent twice
      expect(reminderMails()).toHaveLength(2);
    });

    it('says how far away the appointment really is when it is sent, not how far it was when queued', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      mailer.reset();
      // The 24-hour reminder is delivered late (say the server was down): only 3 hours remain.
      await dispatch(new Date(startOf(date, '10:15') - 3 * HOUR));
      const mail = reminderMails().find((message) => message.text.includes('in about'))!;
      expect(mail.text).toContain('in about 3 hours');
      expect(mail.text).not.toContain('1 day');
      expect(sms.sent.some((message) => message.body.includes('CareSlot reminder'))).toBe(true);
      expect(booked.id).toBeTruthy();
    });

    it('describes the appointment as it is now: a corrected time appears in the reminder', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      await db.query("UPDATE appointments SET start_time = '11:30', end_time = '11:45' WHERE id = $1", [booked.id]);
      mailer.reset();
      await makeDue(booked.id);
      await dispatch();
      const mail = reminderMails()[0];
      expect(mail.text).toContain('11:30 AM – 11:45 AM');
      expect(mail.text).not.toContain('10:15 AM');
      expect(mail.subject).toContain('11:30 AM');
    });

    it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW', 'PENDING'])('does not send a reminder if the appointment became %s in the meantime', async (status) => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await dispatch(); // the booking confirmations go out first; this test is about the reminders
      await setStatus(booked.id, status);
      mailer.reset();
      await makeDue(booked.id);
      const result = await dispatch();
      expect(result.sent).toBe(0);
      expect(reminderMails()).toHaveLength(0);
      expect(sms.sent.filter((message) => message.body.startsWith('CareSlot reminder'))).toHaveLength(0);
      const list = await reminders(booked.id);
      expect(list.every((row) => row.status === 'CANCELLED' && /Not sent: the appointment is /.test(row.last_error ?? ''))).toBe(true);
    });

    it('does not send a reminder for an appointment that has already started', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      mailer.reset();
      await dispatch(new Date(startOf(date, '10:20')));
      expect(reminderMails()).toHaveLength(0);
      expect((await reminders(booked.id)).every((row) => row.status === 'CANCELLED' && row.last_error === 'Not sent: the appointment has already started.')).toBe(true);
    });
  });

  // ================================================================ lifecycle

  describe('cancelling and rescheduling', () => {
    it('withdraws all pending reminders when the patient cancels', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      expect(await live(booked.id)).toHaveLength(4);
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      expect((await reminders(booked.id)).every((row) => row.status === 'CANCELLED')).toBe(true);
      mailer.reset();
      await makeDue(booked.id);
      await dispatch();
      expect(reminderMails()).toHaveLength(0);
    });

    it('withdraws them when the doctor cancels', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await http().post(`/api/doctor-portal/appointments/${booked.id}/cancel`).set(as(tokens.doctor)).send({ reason: 'Emergency' }).expect(200);
      expect((await reminders(booked.id)).every((row) => row.status === 'CANCELLED')).toBe(true);
    });

    it('replaces them with reminders for the new time when rescheduled, and keeps doing so on every move', async () => {
      const date = nextDay();
      const first = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      const second = (await http().post(`/api/appointments/${first.id}/reschedule`).set(as(tokens.patient1)).send({ date, startTime: '11:00' }).expect(201)).body;
      expect((await reminders(first.id)).every((row) => row.status === 'CANCELLED')).toBe(true);
      expect((await live(second.id)).map((row) => row.send_at.getTime()).sort((a, b) => a - b)).toEqual(
        [reminderAt(date, '11:00', 24), reminderAt(date, '11:00', 24), reminderAt(date, '11:00', 1), reminderAt(date, '11:00', 1)].map((at) => at.getTime()).sort((a, b) => a - b),
      );
      const third = (await http().post(`/api/appointments/${second.id}/reschedule`).set(as(tokens.patient1)).send({ date, startTime: '11:30' }).expect(201)).body;
      expect(await live(second.id)).toHaveLength(0);
      expect(await live(third.id)).toHaveLength(4);
      // Only the reminders for the final time are ever delivered.
      mailer.reset();
      await makeDue(first.id);
      await makeDue(second.id);
      await makeDue(third.id);
      await dispatch();
      expect(reminderMails()).toHaveLength(2);
      expect(reminderMails().every((message) => message.text.includes('11:30 AM – 11:45 AM'))).toBe(true);
    });
  });

  // ================================================================ durability

  describe('surviving a restart', () => {
    it('keeps its reminders in the database, so a restarted backend still delivers them, once', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      await dispatch();
      mailer.reset();
      sms.sent.length = 0;

      await app.close(); // the backend goes down...
      app = await makeApp(); // ...and comes back with nothing in memory
      notifications = app.get(NotificationsService);
      dataSource = app.get(DataSource);
      tokens.patient1 = await login('patient1@test.local');

      expect(await live(booked.id)).toHaveLength(4); // all still there
      await makeDue(booked.id);
      await dispatch();
      expect(reminderMails()).toHaveLength(2);
      expect(sms.sent).toHaveLength(2);
      expect((await notifications.maintainReminders()).scheduled).toBe(0); // repair finds nothing to add
      await dispatch();
      expect(reminderMails()).toHaveLength(2);
    });
  });

  describe('keeping reminders correct without anyone clicking', () => {
    it('schedules the reminders an appointment is missing, once, and never again after that', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      await db.query("DELETE FROM notifications WHERE appointment_id = $1 AND kind = 'reminder'", [booked.id]); // as if their queueing had failed
      expect(await reminders(booked.id)).toHaveLength(0);

      expect((await notifications.maintainReminders()).scheduled).toBe(1);
      expect(await live(booked.id)).toHaveLength(4);
      expect((await notifications.maintainReminders()).scheduled).toBe(0);
      expect(await reminders(booked.id)).toHaveLength(4);
    });

    it('picks up a new interval added to the settings, for appointments already booked', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      const config = (notifications as unknown as { config: { reminderHoursBefore: number[] } }).config;
      config.reminderHoursBefore = [24, 3, 1];
      try {
        await notifications.maintainReminders();
      } finally {
        config.reminderHoursBefore = [24, 1];
      }
      const hours = (await live(booked.id)).map((row) => (startOf(date, '10:15') - row.send_at.getTime()) / HOUR);
      expect(hours.sort((a, b) => a - b)).toEqual([1, 1, 3, 3, 24, 24]);
    });

    it('leaves cancelled and past appointments alone, and skips an interval that has already gone by', async () => {
      const cancelled = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await http().post(`/api/appointments/${cancelled.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      await db.query("DELETE FROM notifications WHERE appointment_id = $1 AND kind = 'reminder'", [cancelled.id]);

      const date = nextDay();
      const soon = (await book(tokens.patient1, date, '10:30').expect(201)).body;
      await db.query("DELETE FROM notifications WHERE appointment_id = $1 AND kind = 'reminder'", [soon.id]);
      await notifications.maintainReminders(new Date(startOf(addDays(date, -1), '20:00'))); // 14.5 hours before: only the 1-hour moment is ahead

      expect(await reminders(cancelled.id)).toHaveLength(0);
      expect((await reminders(soon.id)).map((row) => row.send_at.getTime())).toEqual([reminderAt(date, '10:30', 1).getTime(), reminderAt(date, '10:30', 1).getTime()]);
    });

    it('withdraws pending reminders when an appointment stops being confirmed by any route', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await setStatus(booked.id, 'COMPLETED'); // e.g. an administrator's correction, bypassing the normal cancel
      const result = await notifications.maintainReminders();
      expect(result.cancelled).toBe(4);
      expect((await reminders(booked.id)).every((row) => row.status === 'CANCELLED')).toBe(true);
    });

    it('runs from the existing background job: it delivers what is due and repairs what is missing', async () => {
      const jobs = app.get(JobsService);
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await db.query("DELETE FROM notifications WHERE appointment_id = $1 AND kind = 'reminder'", [booked.id]);
      await jobs.runOnce(); // the first pass after start-up includes the reminder upkeep
      expect(await live(booked.id)).toHaveLength(4);
      mailer.reset();
      await makeDue(booked.id);
      await jobs.runOnce();
      expect(reminderMails()).toHaveLength(2);
    });
  });

  describe('one reminder per appointment, interval and channel', () => {
    const config = () => (notifications as unknown as { config: { reminderHoursBefore: number[] } }).config;
    const withIntervals = async (hours: number[], work: () => Promise<void>) => {
      const original = config().reminderHoursBefore;
      config().reminderHoursBefore = hours;
      try {
        await work();
      } finally {
        config().reminderHoursBefore = original;
      }
    };
    /** The interval in a reminder's key ("24", "1"...), read by position so it can never be confused with part of an id. */
    const hoursOf = (key: string) => key.split(':')[2];
    /** "24/email", "1/sms", ... for every live reminder of an appointment. */
    const slots = async (appointmentId: string) => (await live(appointmentId)).map((row) => `${row.dedupe_key.split(':')[2]}/${row.channel}`).sort();
    const insertTwin = async (appointmentId: string, key: string, status = 'PENDING') => {
      const [original] = await rows<Row & { recipient_user_id: string; send_at: Date }>("SELECT * FROM notifications WHERE appointment_id = $1 AND kind = 'reminder' AND channel = 'email' ORDER BY send_at LIMIT 1", [appointmentId]);
      await db.query(
        `INSERT INTO notifications (appointment_id, channel, category, kind, recipient_user_id, recipient_role, to_address, subject, body, send_at, dedupe_key, status)
         VALUES ($1, 'email', 'reminder', 'reminder', $2, 'PATIENT', $3, $4, $5, $6, $7, $8)`,
        [appointmentId, original.recipient_user_id, original.to_address, original.subject, original.body, original.send_at, key, status],
      );
      return original;
    };

    it('keeps the 24-hour and the 1-hour reminders as separate valid reminders, exactly one for each interval and channel', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      expect(await slots(booked.id)).toEqual(['1/email', '1/sms', '24/email', '24/sms']);
      for (let run = 0; run < 3; run++) await notifications.maintainReminders();
      expect(await slots(booked.id)).toEqual(['1/email', '1/sms', '24/email', '24/sms']); // repairing never adds or removes a valid one
    });

    it('lists an interval twice in the settings and still schedules it once', async () => {
      await withIntervals([24, 24, 1, 1], async () => {
        const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
        expect(await slots(booked.id)).toEqual(['1/email', '1/sms', '24/email', '24/sms']);
      });
    });

    it('cancels the reminders of an interval that was removed from the settings, so 24h + 2h + 1h never pile up', async () => {
      let booked: { id: string };
      await withIntervals([24, 2], async () => {
        booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
        expect(await slots(booked.id)).toEqual(['2/email', '2/sms', '24/email', '24/sms']);
      });
      const before = await live(booked!.id);
      const day = before.filter((row) => hoursOf(row.dedupe_key) === '24');

      // The setting changes from "24,2" to "24,1": the 1-hour reminder is added and the 2-hour one retired.
      const result = await notifications.maintainReminders();
      expect(result.redundant).toBe(2);
      expect(await slots(booked!.id)).toEqual(['1/email', '1/sms', '24/email', '24/sms']);
      const retired = (await reminders(booked!.id)).filter((row) => hoursOf(row.dedupe_key) === '2');
      expect(retired.every((row) => row.status === 'CANCELLED' && row.last_error === 'Not sent: this reminder interval is no longer configured.')).toBe(true);
      // The valid 24-hour reminders are the very same rows as before: nothing valid was removed or recreated.
      expect((await live(booked!.id)).filter((row) => hoursOf(row.dedupe_key) === '24').map((row) => row.id).sort()).toEqual(day.map((row) => row.id).sort());
    });

    it('never sends a reminder for a retired interval', async () => {
      await withIntervals([24, 2], async () => {
        await book(tokens.patient2, nextDay(), '10:15').expect(201);
      });
      await notifications.maintainReminders();
      await dispatch();
      mailer.reset();
      await db.query("UPDATE notifications SET send_at = now() - interval '1 minute' WHERE kind = 'reminder' AND status = 'PENDING'");
      await dispatch();
      expect(reminderMails()).toHaveLength(2); // the 24-hour and the 1-hour one, and no third
    });

    it('brings an interval back if it is added to the settings again before it is due', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await withIntervals([24], async () => {
        await notifications.maintainReminders();
        expect(await slots(booked.id)).toEqual(['24/email', '24/sms']);
      });
      const result = await notifications.maintainReminders(); // back to "24,1"
      expect(result.restored).toBe(2);
      expect(await slots(booked.id)).toEqual(['1/email', '1/sms', '24/email', '24/sms']);
      expect((await reminders(booked.id)).filter((row) => hoursOf(row.dedupe_key) === '1')).toHaveLength(2); // restored, not duplicated
    });

    it('cancels a true duplicate (same appointment, interval and channel under a differently written key) and keeps one', async () => {
      const booked = (await book(tokens.patient2, nextDay(), '10:15').expect(201)).body;
      const original = await insertTwin(booked.id, `reminder:${booked.id}:24.0`);
      expect((await live(booked.id)).filter((row) => row.send_at.getTime() === original.send_at.getTime())).toHaveLength(2);

      const result = await notifications.maintainReminders();
      expect(result.redundant).toBe(1);
      expect(await slots(booked.id)).toEqual(['1/email', '24/email']); // one per interval again
      const twin = (await reminders(booked.id)).find((row) => row.dedupe_key.endsWith(':24.0'))!;
      expect(twin).toMatchObject({ status: 'CANCELLED', last_error: 'Not sent: a duplicate of another reminder for the same appointment, interval and channel.' });
      expect((await reminders(booked.id)).find((row) => row.id === original.id)!.status).toBe('PENDING'); // the original survives
    });

    it('keeps the one that was already sent when a pending twin turns up, and never touches the other interval', async () => {
      const booked = (await book(tokens.patient2, nextDay(), '10:15').expect(201)).body;
      await dispatch();
      await db.query("UPDATE notifications SET status = 'SENT', sent_at = now(), attempts = 1 WHERE appointment_id = $1 AND kind = 'reminder' AND split_part(dedupe_key, ':', 3) = '24'", [booked.id]);
      await insertTwin(booked.id, `reminder:${booked.id}:24.00`);
      await notifications.maintainReminders();
      const all = await reminders(booked.id);
      expect(all.find((row) => row.dedupe_key.endsWith(':24'))!.status).toBe('SENT');
      expect(all.find((row) => row.dedupe_key.endsWith(':24.00'))!.status).toBe('CANCELLED');
      expect(all.find((row) => row.dedupe_key.endsWith(':1'))!.status).toBe('PENDING');
      mailer.reset();
      await db.query("UPDATE notifications SET send_at = now() - interval '1 minute' WHERE status = 'PENDING' AND kind = 'reminder'");
      await dispatch();
      expect(reminderMails()).toHaveLength(1); // only the 1-hour one goes: the 24-hour one was already sent, its twin is cancelled
    });

    it('sends a reminder at most once even if a duplicate row exists when it falls due', async () => {
      const booked = (await book(tokens.patient2, nextDay(), '10:15').expect(201)).body;
      await dispatch();
      mailer.reset();
      await insertTwin(booked.id, `reminder:${booked.id}:24.0`);
      await notifications.maintainReminders(); // the repair runs before the reminder is due
      await makeDue(booked.id);
      await dispatch();
      expect(reminderMails()).toHaveLength(2); // one 24-hour, one 1-hour: never two of the same
    });
  });

  describe('what the patient sees in the reminder list', () => {
    type Item = {
      kind: string;
      status: string;
      intervalHours: number | null;
      channel: 'email' | 'sms';
      sendAt: string;
      appointmentId: string;
      appointment: { doctorName: string; date: string; startTime: string; endTime: string } | null;
    };
    const list = async (token: string) => (await http().get('/api/notifications/mine').set(as(token)).expect(200)).body as Item[];

    it('says which interval each reminder is, when it will be sent, and which appointment it is for', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      const upcoming = (await list(tokens.patient1)).filter((item) => item.kind === 'reminder');
      // Each interval appears once per channel: the 24-hour and the 1-hour reminders are separate, by email and by text.
      expect(upcoming.map((item) => `${item.intervalHours}/${item.channel}`).sort()).toEqual(['1/email', '1/sms', '24/email', '24/sms']);
      for (const item of upcoming) {
        expect(item.status).toBe('SCHEDULED');
        expect(item.appointmentId).toBe(booked.id);
        expect(item.appointment).toEqual({ doctorName: 'Dr. Free Doctor', date, startTime: '10:15', endTime: '10:30' });
        expect(new Date(item.sendAt).getTime()).toBe(reminderAt(date, '10:15', item.intervalHours!).getTime());
      }
    });

    it('lists each reminder once even if an older duplicate row exists, and never the same interval twice for an appointment', async () => {
      const booked = (await book(tokens.patient2, nextDay(), '10:15').expect(201)).body;
      const [original] = await rows<{ recipient_user_id: string; to_address: string; subject: string; body: string; send_at: Date }>(
        "SELECT * FROM notifications WHERE appointment_id = $1 AND kind = 'reminder' ORDER BY send_at LIMIT 1",
        [booked.id],
      );
      await db.query(
        `INSERT INTO notifications (appointment_id, channel, category, kind, recipient_user_id, recipient_role, to_address, subject, body, send_at, dedupe_key, status)
         VALUES ($1, 'email', 'reminder', 'reminder', $2, 'PATIENT', $3, $4, $5, $6, $7, 'PENDING')`,
        [booked.id, original.recipient_user_id, original.to_address, original.subject, original.body, original.send_at, `reminder:${booked.id}:24.0`],
      );
      const reminderItems = (await list(tokens.patient2)).filter((item) => item.kind === 'reminder');
      expect(reminderItems.map((item) => item.intervalHours).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 24]);
    });

    it('lists a duplicate text reminder once too, and never merges reminders that differ by interval or channel', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      const [text] = await rows<{ recipient_user_id: string; to_address: string; subject: string; body: string; send_at: Date }>(
        "SELECT * FROM notifications WHERE appointment_id = $1 AND kind = 'reminder' AND channel = 'sms' ORDER BY send_at LIMIT 1",
        [booked.id],
      );
      await db.query(
        `INSERT INTO notifications (appointment_id, channel, category, kind, recipient_user_id, recipient_role, to_address, subject, body, send_at, dedupe_key, status)
         VALUES ($1, 'sms', 'reminder', 'reminder', $2, 'PATIENT', $3, $4, $5, $6, $7, 'PENDING')`,
        [booked.id, text.recipient_user_id, text.to_address, text.subject, text.body, text.send_at, `reminder:${booked.id}:24.0:sms`],
      );
      const reminderItems = (await list(tokens.patient1)).filter((item) => item.kind === 'reminder');
      expect(reminderItems).toHaveLength(4);
      expect(reminderItems.map((item) => `${item.intervalHours}/${item.channel}`).sort()).toEqual(['1/email', '1/sms', '24/email', '24/sms']);
    });

    it('hides no valid reminder: with email reminders off, the text reminders are still listed, and the other way round', async () => {
      await setPrefs(tokens.patient1, { emailReminders: false }).expect(200);
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      let items = (await list(tokens.patient1)).filter((item) => item.kind === 'reminder' && item.appointmentId === booked.id);
      expect(items.map((item) => `${item.intervalHours}/${item.channel}`).sort()).toEqual(['1/sms', '24/sms']);
      await setPrefs(tokens.patient1, { emailReminders: true, smsReminders: false }).expect(200);
      items = (await list(tokens.patient1)).filter((item) => item.kind === 'reminder' && item.appointmentId === booked.id);
      expect(items.map((item) => `${item.intervalHours}/${item.channel}`).sort()).toEqual(['1/email', '24/email']);
    });

    it('does not expose how reminders are keyed internally, and still lists only the patient’s own', async () => {
      await book(tokens.patient1, nextDay(), '10:15').expect(201);
      const mine = await list(tokens.patient1);
      expect(JSON.stringify(mine)).not.toMatch(/dedupe|reminder:[0-9a-f-]{36}/);
      expect((await list(tokens.patient2)).filter((item) => item.kind === 'reminder')).toHaveLength(0);
    });

    it('shows a sent reminder as sent, in the same shape, with the interval it was for', async () => {
      const booked = (await book(tokens.patient2, nextDay(), '10:15').expect(201)).body;
      await makeDue(booked.id);
      await dispatch();
      const items = (await list(tokens.patient2)).filter((item) => item.kind === 'reminder');
      expect(items.every((item) => item.status === 'SENT')).toBe(true);
      expect(items.map((item) => item.intervalHours).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 24]);
    });
  });

  describe('duplicates', () => {
    it('never creates the same reminder twice, however often the event or the repair runs', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      for (let run = 0; run < 3; run++) {
        await dataSource.transaction((manager) => notifications.bookingConfirmed(manager, booked.id));
        await notifications.maintainReminders();
      }
      expect(await reminders(booked.id)).toHaveLength(4);
    });

    it('sends each reminder exactly once even when two workers run at the same moment', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await dispatch();
      mailer.reset();
      sms.sent.length = 0;
      await makeDue(booked.id);
      await Promise.all([dispatch(), dispatch(), dispatch()]);
      expect(reminderMails()).toHaveLength(2);
      expect(sms.sent.filter((message) => message.body.startsWith('CareSlot reminder'))).toHaveLength(2);
    });
  });

  describe('when a provider fails', () => {
    it('retries a reminder with growing waits, and sends the up-to-date version when it finally goes', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient2, date, '10:15').expect(201)).body;
      await dispatch();
      mailer.reset();
      mailer.failure = new DeliveryError('Resend responded with HTTP 503', true);
      mailer.failTimes = 2;
      await makeDue(booked.id);
      const t0 = new Date(Date.now() + 1000);
      await dispatch(t0);
      const first = (await reminders(booked.id)).filter((row) => row.status === 'PENDING');
      expect(first.every((row) => row.attempts === 1 || row.attempts === 0)).toBe(true);
      const failing = (await reminders(booked.id)).find((row) => row.attempts === 1)!;
      expect(failing.send_at.getTime()).toBe(t0.getTime() + 60_000);

      await db.query("UPDATE appointments SET start_time = '11:45', end_time = '12:00' WHERE id = $1", [booked.id]); // changes while we wait
      await dispatch(new Date(t0.getTime() + 61_000)); // second failure
      await dispatch(new Date(t0.getTime() + 61_000 + 121_000)); // succeeds
      expect(reminderMails().length).toBeGreaterThanOrEqual(1);
      expect(reminderMails().every((message) => message.text.includes('11:45 AM – 12:00 PM'))).toBe(true);
    });

    it('does not send a retried reminder if the appointment was cancelled while it waited', async () => {
      const booked = (await book(tokens.patient2, nextDay(), '10:15').expect(201)).body;
      await dispatch();
      mailer.reset();
      mailer.failure = new DeliveryError('Resend responded with HTTP 503', true);
      await makeDue(booked.id);
      const t0 = new Date(Date.now() + 1000);
      await dispatch(t0);
      await setStatus(booked.id, 'CANCELLED'); // cancelled by some route that did not clean up
      mailer.reset();
      await dispatch(new Date(t0.getTime() + 61_000));
      expect(reminderMails()).toHaveLength(0);
      expect((await reminders(booked.id)).every((row) => row.status === 'CANCELLED')).toBe(true);
    });

    it('keeps a permanently refused reminder as FAILED, and lets a failing text not hold up the email', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await dispatch();
      mailer.reset();
      sms.sent.length = 0;
      sms.failWith = new DeliveryError("Twilio responded with HTTP 400 (21211: The 'To' number is not a valid phone number.)", false, '21211');
      await makeDue(booked.id);
      await dispatch();
      expect(reminderMails()).toHaveLength(2); // the emails went regardless
      const texts = (await reminders(booked.id)).filter((row) => row.channel === 'sms');
      expect(texts.every((row) => row.status === 'FAILED' && row.attempts === 1 && (row.last_error ?? '').includes('21211'))).toBe(true);
    });
  });

  // ================================================================ preferences and consent

  describe('notification preferences', () => {
    it('start with essential updates and reminders on and nothing promotional, and say whether a text could reach the patient', async () => {
      const mine = (await prefs(tokens.patient1).expect(200)).body;
      expect(mine).toMatchObject({
        smsEnabled: true,
        emailReminders: true,
        smsReminders: true,
        promotionalEmail: false,
        promotionalSms: false,
        promotionalEmailConsentAt: null,
        promotionalSmsConsentAt: null,
        smsNumberOnFile: true,
        smsServiceAvailable: true,
      });
      expect((await prefs(tokens.patient2).expect(200)).body.smsNumberOnFile).toBe(false);
      expect(await rows('SELECT 1 FROM notification_preferences')).toHaveLength(0); // reading never writes
    });

    it('can be changed, one choice at a time, and are kept per patient', async () => {
      const changed = (await setPrefs(tokens.patient1, { emailReminders: false }).expect(200)).body;
      expect(changed).toMatchObject({ emailReminders: false, smsReminders: true, smsEnabled: true });
      expect((await prefs(tokens.patient1).expect(200)).body.emailReminders).toBe(false);
      expect((await prefs(tokens.patient2).expect(200)).body.emailReminders).toBe(true); // somebody else's choice is untouched
      await setPrefs(tokens.patient1, { smsEnabled: false, smsReminders: false }).expect(200);
      expect((await prefs(tokens.patient1).expect(200)).body).toMatchObject({ emailReminders: false, smsEnabled: false, smsReminders: false });
    });

    it('records when promotional consent was given, clears it when withdrawn, and does not move it on a repeat', async () => {
      const on = (await setPrefs(tokens.patient1, { promotionalEmail: true }).expect(200)).body;
      expect(on.promotionalEmail).toBe(true);
      expect(new Date(on.promotionalEmailConsentAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(on.promotionalSms).toBe(false);
      expect(on.promotionalSmsConsentAt).toBeNull();
      const again = (await setPrefs(tokens.patient1, { promotionalEmail: true }).expect(200)).body;
      expect(again.promotionalEmailConsentAt).toBe(on.promotionalEmailConsentAt); // consent is dated once, when given
      const off = (await setPrefs(tokens.patient1, { promotionalEmail: false }).expect(200)).body;
      expect(off).toMatchObject({ promotionalEmail: false, promotionalEmailConsentAt: null });
    });

    it('cannot be used to switch off the essential emails, and rejects anything it does not understand', async () => {
      for (const bad of [{}, { essentialEmail: false }, { transactionalEmail: false }, { smsEnabled: 'no' }, { emailReminders: null }, { smsEnabled: true, extra: 1 }]) {
        await setPrefs(tokens.patient1, bad).expect(400);
      }
      expect(await rows('SELECT 1 FROM notification_preferences')).toHaveLength(0);
    });

    it('are for patients only', async () => {
      await prefs(tokens.doctor).expect(403);
      await setPrefs(tokens.doctor, { smsEnabled: false }).expect(403);
      await http().get('/api/notifications/preferences').expect(401);
      await http().put('/api/notifications/preferences').send({ smsEnabled: false }).expect(401);
    });

    it('turn off email reminders: no reminder emails are scheduled, texts still are, and essential emails still go', async () => {
      await setPrefs(tokens.patient1, { emailReminders: false }).expect(200);
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      expect((await reminders(booked.id)).map((row) => row.channel)).toEqual(['sms', 'sms']);
      await dispatch();
      expect(mailer.sent.some((message) => message.to === 'patient1@test.local' && message.subject.startsWith('Appointment confirmed'))).toBe(true);
    });

    it('turn off text reminders: only the emails remain, and texts for essential updates still go', async () => {
      await setPrefs(tokens.patient1, { smsReminders: false }).expect(200);
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      expect((await reminders(booked.id)).map((row) => row.channel)).toEqual(['email', 'email']);
      await dispatch();
      expect(sms.sent.some((message) => message.body.startsWith('CareSlot: appointment confirmed'))).toBe(true);
    });

    it('turn off texts altogether: no text of any kind, but every email, essential ones included, is still sent', async () => {
      await setPrefs(tokens.patient1, { smsEnabled: false }).expect(200);
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(tokens.patient1)).send({}).expect(200);
      const all = await rows<Row>('SELECT * FROM notifications WHERE appointment_id = $1', [booked.id]);
      expect(all.some((row) => row.channel === 'sms')).toBe(false);
      await dispatch();
      expect(sms.sent).toHaveLength(0);
      const subjects = mailer.sent.filter((message) => message.to === 'patient1@test.local').map((message) => message.subject);
      expect(subjects.some((subject) => subject.startsWith('Appointment confirmed'))).toBe(true);
      expect(subjects.some((subject) => subject.startsWith('Appointment cancelled'))).toBe(true);
    });

    it('turn off every reminder: none are scheduled, and a repair does not bring them back', async () => {
      await setPrefs(tokens.patient1, { emailReminders: false, smsReminders: false }).expect(200);
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      expect(await reminders(booked.id)).toHaveLength(0);
      await notifications.maintainReminders();
      expect(await reminders(booked.id)).toHaveLength(0);
    });

    it('take effect on reminders already queued: opting out cancels them at once, and opting back in restores them', async () => {
      const date = nextDay();
      const booked = (await book(tokens.patient1, date, '10:15').expect(201)).body;
      expect(await live(booked.id)).toHaveLength(4);

      await setPrefs(tokens.patient1, { smsReminders: false }).expect(200);
      const afterTexts = await reminders(booked.id);
      expect(afterTexts.filter((row) => row.channel === 'sms').every((row) => row.status === 'CANCELLED')).toBe(true);
      expect(afterTexts.filter((row) => row.channel === 'email').every((row) => row.status === 'PENDING')).toBe(true);

      await setPrefs(tokens.patient1, { emailReminders: false }).expect(200);
      expect(await live(booked.id)).toHaveLength(0);

      await setPrefs(tokens.patient1, { emailReminders: true, smsReminders: true }).expect(200); // changed their mind before the reminders were due
      expect(await live(booked.id)).toHaveLength(4);
      mailer.reset();
      await makeDue(booked.id);
      await dispatch();
      expect(reminderMails()).toHaveLength(2);
    });

    it('are checked again at the moment of delivery, so a last-minute opt-out is honoured', async () => {
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await dispatch();
      mailer.reset();
      sms.sent.length = 0;
      await makeDue(booked.id);
      // The patient opts out directly in the database, as a change that arrives between the queue and the send.
      await db.query("INSERT INTO notification_preferences (user_id, sms_enabled, email_reminders, sms_reminders) SELECT id, true, false, false FROM users WHERE email = 'patient1@test.local'");
      await dispatch();
      expect(reminderMails()).toHaveLength(0);
      expect(sms.sent).toHaveLength(0);
      expect((await reminders(booked.id)).every((row) => row.status === 'CANCELLED' && (row.last_error ?? '').includes('preferences'))).toBe(true);
    });
  });

  describe('promotional messages need explicit consent', () => {
    const queuePromotional = async (channel: 'email' | 'sms', key: string) => {
      const patient = (await rows<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = 'patient1@test.local'"))[0];
      await db.query(
        `INSERT INTO notifications (channel, category, kind, recipient_user_id, recipient_role, to_address, subject, body, dedupe_key)
         VALUES ($1, 'promotional', 'offer', $2, 'PATIENT', $3, 'A health check offer', 'Offer text', $4)`,
        [channel, patient.id, channel === 'sms' ? '+919876543210' : patient.email, key],
      );
    };

    it('are never sent without the patient opting in: they are cancelled, not failed or retried', async () => {
      await queuePromotional('email', 'promo-1');
      await queuePromotional('sms', 'promo-2');
      const result = await dispatch();
      expect(result).toMatchObject({ sent: 0, skipped: 2, failed: 0 });
      expect(mailer.sent).toHaveLength(0);
      expect(sms.sent).toHaveLength(0);
      const all = await rows<Row>("SELECT * FROM notifications WHERE category = 'promotional'");
      expect(all.every((row) => row.status === 'CANCELLED' && (row.last_error ?? '').includes('preferences'))).toBe(true);
    });

    it('are sent once the patient has opted in for that channel, and only that channel', async () => {
      await setPrefs(tokens.patient1, { promotionalEmail: true }).expect(200);
      await queuePromotional('email', 'promo-3');
      await queuePromotional('sms', 'promo-4');
      await dispatch();
      expect(mailer.sent.map((message) => message.subject)).toEqual(['A health check offer']);
      expect(sms.sent).toHaveLength(0);
    });

    it('stop the moment consent is withdrawn, even for a message already queued', async () => {
      await setPrefs(tokens.patient1, { promotionalEmail: true }).expect(200);
      await queuePromotional('email', 'promo-5');
      await setPrefs(tokens.patient1, { promotionalEmail: false }).expect(200);
      await dispatch();
      expect(mailer.sent).toHaveLength(0);
      const [row] = await rows<Row>("SELECT * FROM notifications WHERE dedupe_key = 'promo-5'");
      expect(row.status).toBe('CANCELLED');
    });

    it('also need texts to be on: turning texts off ends promotional texts as well', async () => {
      await setPrefs(tokens.patient1, { promotionalSms: true }).expect(200);
      await queuePromotional('sms', 'promo-6');
      await dispatch();
      expect(sms.sent).toHaveLength(1);
      await setPrefs(tokens.patient1, { smsEnabled: false }).expect(200);
      await queuePromotional('sms', 'promo-7');
      await dispatch();
      expect(sms.sent).toHaveLength(1);
    });

    it('never get in the way of essential messages: those go out whatever the promotional choices are', async () => {
      await setPrefs(tokens.patient1, { promotionalEmail: false, promotionalSms: false }).expect(200);
      const booked = (await book(tokens.patient1, nextDay(), '10:15').expect(201)).body;
      await dispatch();
      expect(mailer.sent.some((message) => message.to === 'patient1@test.local' && message.subject.startsWith('Appointment confirmed'))).toBe(true);
      expect(booked.id).toBeTruthy();
    });
  });
});
