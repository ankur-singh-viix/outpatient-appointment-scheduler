// What a patient is told about the queue: a check-in notice with their token (email, and a text when they have a phone and allow texts) and a
// "your turn" text when the doctor calls them.
//  - one notice per queue entry, however often the request is repeated or the queue is polled;
//  - the existing notification rules apply: preferences, a usable phone number, the outbox, retries and the dedupe keys;
//  - a notification that cannot be queued or delivered never undoes a check-in or disturbs the queue.
// The real app, database and services run; only the email and SMS providers are replaced (no real message is ever sent).

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EMAIL_SENDER } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { DeliveryError } from '../src/notifications/delivery-error.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { MockSmsProvider, SMS_PROVIDER } from '../src/notifications/sms-provider.js';
import { clinicNow } from '../src/scheduling/calendar.js';

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

describe('Queue notifications (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  let receptionToken: string;
  const patientIds: string[] = [];
  const patientUserIds: string[] = [];
  const patientTokens: string[] = [];
  const sms = new MockSmsProvider();
  const emails: { to: string; subject: string; text: string }[] = [];
  let mailDown = false;
  let seq = 0;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const dispatch = () => app.get(NotificationsService).dispatchDue(new Date(Date.now() + 3_600_000), 200);
  const checkIn = (id: string) => http().post(`/api/queue/reception/appointments/${id}/check-in`).set(as(receptionToken)).send({});
  const callNext = () => http().post('/api/queue/doctor/call-next').set(as(doctorToken)).send({});
  const queued = (kind: string) => rows<{ channel: string; to_address: string; status: string; dedupe_key: string; body: string; subject: string }>('SELECT channel, to_address, status, dedupe_key, body, subject FROM notifications WHERE kind = $1 ORDER BY channel', [kind]);

  const appt = async (patient: number) => {
    const n = ++seq;
    const start = `${String(8 + Math.floor(n / 2)).padStart(2, '0')}:${n % 2 ? '30' : '00'}`;
    const id = (
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, slot_capacity, slot_number, status)
         VALUES ($1, $2, $3, $4, $5::time, ($5::time + interval '30 minutes'), 1, 1, 'CONFIRMED') RETURNING id`,
        [patientIds[patient], doctorId, patientUserIds[patient], today, start],
      )
    ).rows[0].id as string;
    const [{ next }] = await rows<{ next: number }>(
      'SELECT COALESCE(MAX(token_number), 0) + 1 AS next FROM queue_entries WHERE doctor_id = $1 AND queue_date = $2',
      [doctorId, today],
    );
    await db.query(
      `INSERT INTO queue_entries (appointment_id, doctor_id, patient_id, queue_date, token_number, status, checked_in_at, checked_in_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'BOOKED', NULL, NULL)`,
      [id, doctorId, patientIds[patient], today, next],
    );
    return id;
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
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic One', '1 A St') RETURNING id")).rows[0].id as string;
    doctorId = (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id', [await user('Dr. Alpha', 'qn-doc@test.local', 'DOCTOR'), clinicId, specialtyId])).rows[0].id as string;
    const receptionist = await user('Rita Reception', 'qn-rec@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2)', [receptionist, clinicId]);
    await db.query('INSERT INTO doctor_receptionist_assignments (doctor_id, receptionist_user_id) VALUES ($1, $2)', [doctorId, receptionist]);
    for (let n = 1; n <= 4; n++) {
      const userId = await user(`Patient ${n}`, `qn-p${n}@test.local`, 'PATIENT');
      patientUserIds.push(userId);
      patientIds.push((await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [userId, n === 3 ? 'not a number' : `+9190000130${n}`])).rows[0].id as string);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: async (message: { to: string; subject: string; text: string }) => {
          if (mailDown) throw new DeliveryError('The email provider is down.', true, 'provider-down');
          emails.push({ to: message.to, subject: message.subject, text: message.text });
          return { reference: `em_${emails.length}` };
        },
      })
      .overrideProvider(SMS_PROVIDER)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('qn-doc@test.local');
    receptionToken = await login('qn-rec@test.local');
    for (let n = 1; n <= 4; n++) patientTokens.push(await login(`qn-p${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM queue_events; DELETE FROM queue_entries; DELETE FROM notifications; DELETE FROM notification_preferences; DELETE FROM appointments;');
    emails.length = 0;
    sms.sent.length = 0;
    sms.failWith = null;
    sms.failTimes = Number.POSITIVE_INFINITY;
    mailDown = false;
    seq = 0;
  });

  describe('the check-in notice', () => {
    it('tells the patient their token by email and by text, with the doctor, the time and how many are ahead', async () => {
      await checkIn(await appt(0)).expect(200);
      const entry = await checkIn(await appt(1)).expect(200);
      expect(entry.body.token).toBe(2);
      const list = await queued('queue-checked-in');
      expect(list.map((row) => [row.channel, row.to_address])).toEqual([
        ['email', 'qn-p1@test.local'],
        ['sms', '+91900001301'],
        ['email', 'qn-p2@test.local'],
        ['sms', '+91900001302'],
      ].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));
      await dispatch();
      const mail = emails.find((message) => message.to === 'qn-p2@test.local')!;
      expect(mail.subject).toBe('You are checked in: token 2, Dr. Alpha');
      expect(mail.text).toMatch(/Your token number is 2\./);
      expect(mail.text).toMatch(/1 patient is ahead of you\./);
      expect(mail.text).toMatch(/Doctor: Dr\. Alpha/);
      const text = sms.sent.find((message) => message.to === '+91900001302')!;
      expect(text.body).toMatch(/^CareSlot: checked in with Dr\. Alpha\. Your token is 2\. 1 patient is ahead of you\./);
      expect(text.body.length).toBeLessThanOrEqual(160);
      expect(emails.find((message) => message.to === 'qn-p1@test.local')!.text).toMatch(/You are next\./);
    });

    it('sends nothing twice: a repeated check-in, polling, and a replay of the same event leave exactly one email and one text', async () => {
      const id = await appt(0);
      await checkIn(id).expect(200);
      await checkIn(id).expect(409); // a double click or a retry
      for (let n = 0; n < 3; n++) {
        await http().get('/api/queue/mine').set(as(patientTokens[0])).expect(200);
        await http().get('/api/queue/doctor').set(as(doctorToken)).expect(200);
        await http().get('/api/queue/reception').set(as(receptionToken)).expect(200);
      }
      const entry = (await rows<{ id: string }>('SELECT id FROM queue_entries'))[0].id;
      // The same event replayed (a retry after a lost response, say) adds nothing: the entry is the dedupe key.
      await app.get(DataSource).transaction((manager) => app.get(NotificationsService).queueCheckedIn(manager, id, { entryId: entry, token: 1, ahead: 0 }));
      const list = await queued('queue-checked-in');
      expect(list.map((row) => row.channel)).toEqual(['email', 'sms']);
      expect(new Set(list.map((row) => row.dedupe_key)).size).toBe(2);
      await dispatch();
      await dispatch();
      expect(emails.filter((message) => message.subject.startsWith('You are checked in'))).toHaveLength(1);
      expect(sms.sent).toHaveLength(1);
    });

    it('follows the patient\'s choices and details: no text when they turned texts off or have no usable number, and the email still goes', async () => {
      await http().put('/api/notifications/preferences').set(as(patientTokens[1])).send({ smsEnabled: false }).expect(200);
      await checkIn(await appt(1)).expect(200); // texts turned off
      await checkIn(await appt(2)).expect(200); // "not a number" as a phone number
      await checkIn(await appt(0)).expect(200); // everything allowed
      const list = await queued('queue-checked-in');
      expect(list.filter((row) => row.channel === 'email').map((row) => row.to_address).sort()).toEqual(['qn-p1@test.local', 'qn-p2@test.local', 'qn-p3@test.local']);
      expect(list.filter((row) => row.channel === 'sms').map((row) => row.to_address)).toEqual(['+91900001301']);
    });
  });

  describe('a notice that cannot be queued or delivered never touches the queue', () => {
    it('a check-in stands, and the queue works, when the outbox cannot be written', async () => {
      const id = await appt(0);
      await db.query('ALTER TABLE notifications RENAME TO notifications_off');
      try {
        const res = await checkIn(id).expect(200);
        expect(res.body).toMatchObject({ token: 1, status: 'WAITING' });
        expect((await callNext().expect(200)).body).toMatchObject({ token: 1, status: 'SERVING' });
      } finally {
        await db.query('ALTER TABLE notifications_off RENAME TO notifications');
      }
      expect(await rows("SELECT status FROM queue_entries")).toEqual([{ status: 'SERVING' }]);
      expect(await queued('queue-checked-in')).toEqual([]);
    });

    it('an email outage is retried and the notice goes out once it is back, with the queue untouched throughout', async () => {
      await checkIn(await appt(0)).expect(200);
      mailDown = true;
      await app.get(NotificationsService).dispatchDue(new Date(Date.now() + 60_000), 200);
      expect(emails).toHaveLength(0);
      const failed = await rows<{ status: string; attempts: number; last_error: string | null }>("SELECT status, attempts, last_error FROM notifications WHERE kind = 'queue-checked-in' AND channel = 'email'");
      expect(failed).toEqual([{ status: 'PENDING', attempts: 1, last_error: expect.stringContaining('down') }]); // still pending: it will be tried again
      expect(await rows('SELECT status FROM queue_entries')).toEqual([{ status: 'WAITING' }]);
      mailDown = false;
      await dispatch();
      expect(emails.filter((message) => message.subject.startsWith('You are checked in'))).toHaveLength(1);
      await dispatch();
      expect(emails.filter((message) => message.subject.startsWith('You are checked in'))).toHaveLength(1);
    });

    it('a failed text does not stop the email, and does not touch the queue', async () => {
      await checkIn(await appt(0)).expect(200);
      sms.failWith = new DeliveryError('Twilio refused the number.', false, 'invalid-number');
      await dispatch();
      expect(emails.filter((message) => message.subject.startsWith('You are checked in'))).toHaveLength(1);
      expect(await rows<{ status: string }>("SELECT status FROM notifications WHERE kind = 'queue-checked-in' AND channel = 'sms'")).toEqual([{ status: 'FAILED' }]);
      expect(await rows('SELECT status FROM queue_entries')).toEqual([{ status: 'WAITING' }]);
      expect((await callNext().expect(200)).body.status).toBe('SERVING');
    });
  });

  describe('the "your turn" text', () => {
    it('is a text only, to the patient called, once', async () => {
      await checkIn(await appt(0)).expect(200);
      await checkIn(await appt(1)).expect(200);
      await callNext().expect(200);
      const list = await queued('queue-called');
      expect(list.map((row) => [row.channel, row.to_address])).toEqual([['sms', '+91900001301']]);
      await dispatch();
      expect(sms.sent.filter((message) => /it is your turn/.test(message.body))).toEqual([expect.objectContaining({ to: '+91900001301', body: "CareSlot: token 1, it is your turn. Please go to Dr. Alpha's consultation room." })]);
      expect(emails.filter((message) => /your turn/.test(message.subject))).toEqual([]);
    });

    it('is not sent again when the same patient is skipped, returned and called again', async () => {
      const first = (await checkIn(await appt(0)).expect(200)).body.id as string;
      await callNext().expect(200);
      await http().post(`/api/queue/doctor/entries/${first}/skip`).set(as(doctorToken)).send({}).expect(200);
      await http().post(`/api/queue/reception/entries/${first}/return`).set(as(receptionToken)).send({}).expect(200);
      expect((await callNext().expect(200)).body).toMatchObject({ id: first, status: 'SERVING' });
      expect(await queued('queue-called')).toHaveLength(1);
    });

    it('has none when the patient allows no texts or has no usable number', async () => {
      await http().put('/api/notifications/preferences').set(as(patientTokens[0])).send({ smsEnabled: false }).expect(200);
      await checkIn(await appt(0)).expect(200);
      await callNext().expect(200);
      expect(await queued('queue-called')).toEqual([]);
    });
  });
});
