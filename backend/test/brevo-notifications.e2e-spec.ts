// The notification set (confirmation, reschedule, cancellation, "choose a new time", "valid again") delivered through the real
// BrevoEmailSender, the real outbox, dispatcher and notifier, against the test database, with a FAKE fetch standing in for Brevo's
// API. Nothing here reaches Brevo or any network: the fake records each request and returns whatever the test says Brevo would.
// So a pass shows our requests, retries, de-duplication and withdrawals behave; it does not show that a real mailbox received mail.

import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { BrevoEmailSender, DisabledEmailSender, EMAIL_SENDER, type EmailSender } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { addDays, clinicNow, dayOfWeek } from '../src/scheduling/calendar.js';
import { ScheduleChangeNotifier } from '../src/scheduling/schedule-change-notifier.service.js';

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
const KEY = 'xkeysib-e2e-fake-key-value';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const nextWeekday = (dow: number, from = 1) => {
  for (let offset = from; offset < from + 8; offset++) if (dayOfWeek(addDays(today, offset)) === dow) return addDays(today, offset);
  throw new Error('unreachable');
};

interface BrevoRequest {
  url: string;
  headers: Record<string, string>;
  body: { sender: { name?: string; email: string }; to: { email: string }[]; subject: string; textContent: string; htmlContent?: string };
}

describe('Notifications through Brevo (mocked API)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  const patientTokens: string[] = [];
  const monday = nextWeekday(1);

  // ---- the fake Brevo ----
  let requests: BrevoRequest[] = [];
  let respond: (call: number) => { status: number; body: unknown } = () => ({ status: 201, body: {} });
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const answer = respond(requests.length);
    return new Response(JSON.stringify(answer.status === 201 && !(answer.body as { messageId?: string }).messageId ? { messageId: `<msg-${requests.length}@brevo.test>` } : answer.body), { status: answer.status });
  }) as unknown as typeof fetch;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const notifier = () => app.get(ScheduleChangeNotifier);
  const dispatch = (now = new Date()) => app.get(NotificationsService).dispatchDue(now, 200);
  const sentTo = (email: string, subject?: RegExp) => requests.filter((r) => r.body.to[0].email === email && (!subject || subject.test(r.body.subject)));
  const notices = (kind: string) => rows<{ status: string; last_error: string | null; attempts: number; provider_reference: string | null }>('SELECT status, last_error, attempts, provider_reference FROM notifications WHERE kind = $1 ORDER BY created_at', [kind]);

  const addRow = async () =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
         VALUES ($1, 'WEEKLY', 1, '10:00', '12:00', 'WAVE', 3, 30) RETURNING id`,
        [doctorId],
      )
    ).rows[0].id as string;
  const current = async () => (await rows<{ id: string }>("SELECT id FROM availability WHERE recurrence_type = 'WEEKLY' AND effective_to IS NULL"))[0].id;
  const change = async (startTime: string, endTime: string, from: { startTime: string; endTime: string }) => {
    const response = await http().post(`/api/doctor-portal/availability/${await current()}/change`).set(as(doctorToken)).send({ startTime, endTime, from, acknowledge: true });
    expect(response.status).toBe(200);
    return response;
  };
  const shrink = () => change('10:00', '11:00', { startTime: '10:00', endTime: '12:00' });
  const extend = () => change('10:00', '12:00', { startTime: '10:00', endTime: '11:00' });
  const book = (patient: number, date: string, startTime: string) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime });
  const settleOthers = (keep: string[]) => db.query("UPDATE notifications SET status = 'SENT' WHERE status = 'PENDING' AND NOT (kind = ANY($1))", [keep]);

  const start = async (sender: EmailSender) => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue(sender).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('brevo-doc@test.local');
    patientTokens.length = 0;
    for (let n = 1; n <= 2; n++) patientTokens.push(await login(`bp${n}@test.local`));
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
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic A', '1 A St') RETURNING id")).rows[0].id as string;
    doctorId = (
      await db.query(`INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id`, [
        await user('Dr. Brevo', 'brevo-doc@test.local', 'DOCTOR'),
        clinicId,
        specialtyId,
      ])
    ).rows[0].id as string;
    for (let n = 1; n <= 2; n++) {
      const id = await user(`Patient ${n}`, `bp${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000000${n}`]);
    }
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    requests = [];
    respond = () => ({ status: 201, body: {} });
  });

  const clean = async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
  };

  describe('with Brevo configured', () => {
    beforeAll(async () => {
      await start(new BrevoEmailSender(KEY, 'CareSlot <no-reply@clinic.example>', fakeFetch));
    });
    afterAll(async () => {
      await app?.close();
    });
    beforeEach(async () => {
      await clean();
      await addRow();
    });

    it('confirms a booking: patient, doctor, specialty, date, time and clinic, as text and HTML, from the verified sender', async () => {
      const globalFetch = vi.spyOn(globalThis, 'fetch');
      const booked = (await book(0, monday, '11:00').expect(201)).body;
      expect(requests).toHaveLength(0); // booking itself sends nothing: the message waits in the outbox
      await dispatch();

      const [mail] = sentTo('bp1@test.local', /^Appointment confirmed/);
      expect(mail.url).toBe('https://api.brevo.com/v3/smtp/email');
      expect(mail.headers['api-key']).toBe(KEY);
      expect(mail.body.sender).toEqual({ name: 'CareSlot', email: 'no-reply@clinic.example' });
      for (const part of ['Patient 1', 'Dr. Brevo', 'Specialty: ENT', '11:00 AM – 11:30 AM', 'Clinic A, 1 A St', 'Your appointment is confirmed']) expect(mail.body.textContent, part).toContain(part);
      expect(mail.body.htmlContent).toContain('<meta name="viewport"');
      for (const part of ['Dr. Brevo', 'ENT', 'Clinic A, 1 A St', '11:00 AM']) expect(mail.body.htmlContent, part).toContain(part);
      expect(sentTo('brevo-doc@test.local', /^New booking/)).toHaveLength(1); // the doctor's copy
      const [row] = await notices('booking-confirmed');
      expect(row).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(row.provider_reference).toMatch(/^<msg-\d+@brevo\.test>$/);
      expect(globalFetch).not.toHaveBeenCalled(); // nothing but the fake ever carried a request
      expect(booked.status).toBe('CONFIRMED');
    });

    it('reschedules: previous and new time, doctor details, and the confirmation that it moved', async () => {
      const booked = (await book(0, monday, '11:00').expect(201)).body;
      await dispatch();
      requests = [];
      await http().post(`/api/appointments/${booked.id}/reschedule`).set(as(patientTokens[0])).send({ date: monday, startTime: '10:30' }).expect(201);
      await dispatch();
      const [mail] = sentTo('bp1@test.local', /^Appointment rescheduled/);
      for (const part of ['was moved from', '11:00 AM', 'New time:', '10:30 AM', 'Dr. Brevo', 'Specialty: ENT', 'Clinic A, 1 A St']) expect(mail.body.textContent, part).toContain(part);
      expect(sentTo('brevo-doc@test.local', /^Booking rescheduled/)).toHaveLength(1);
    });

    it('cancels: appointment details, the confirmation, and what to do next', async () => {
      const booked = (await book(0, monday, '11:00').expect(201)).body;
      await dispatch();
      requests = [];
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(patientTokens[0])).send({ reason: 'Travelling' }).expect(200);
      await dispatch();
      const [mail] = sentTo('bp1@test.local', /^Appointment cancelled/);
      for (const part of ['cancelled by you', 'Reason: Travelling', 'Dr. Brevo', 'Clinic A', 'What you can do next', 'book another time']) expect(mail.body.textContent, part).toContain(part);
      expect(mail.body.htmlContent).toContain('Travelling');
    });

    it('availability shrinking: asks the patient to choose a new time, with the link, and cancels nothing', async () => {
      const booked = (await book(0, monday, '11:30').expect(201)).body;
      await dispatch();
      requests = [];
      await shrink();
      await notifier().drain();
      await settleOthers(['needs-new-time']);
      await dispatch();

      const [mail] = sentTo('bp1@test.local', /^Please choose a new time/);
      for (const part of ['Dr. Brevo', 'changed their hours', 'Nothing has been cancelled or moved', '11:30 AM', `/doctors/${doctorId}?reschedule=${booked.id}`, 'confirm the move']) expect(mail.body.textContent, part).toContain(part);
      expect(mail.body.htmlContent).toContain(`<a href="`);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [booked.id])).toEqual([{ status: 'CONFIRMED' }]);
    });

    it('availability expansion: a patient who was asked is told the appointment is valid again, once', async () => {
      const booked = (await book(0, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();
      await dispatch(); // the "choose a new time" email goes out
      expect(sentTo('bp1@test.local', /^Please choose a new time/)).toHaveLength(1);
      requests = [];

      const done = (await extend()).body;
      expect(done.restoredAppointments).toBe(1);
      expect(requests).toHaveLength(0); // queued in the transaction, sent by the dispatcher
      await dispatch();
      const [mail] = sentTo('bp1@test.local', /^No action needed/);
      for (const part of ['valid again', 'You do not need to do anything or reschedule', 'Dr. Brevo', '11:30 AM', 'Clinic A']) expect(mail.body.textContent, part).toContain(part);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [booked.id])).toEqual([{ status: 'CONFIRMED' }]);

      // Repeating anything never repeats the message.
      await dispatch();
      await notifier().drain();
      await dispatch();
      expect(sentTo('bp1@test.local', /^No action needed/)).toHaveLength(1);
      expect(await notices('appointment-restored')).toHaveLength(1);
    });

    it('availability expansion: a patient who was never asked (notice still queued) gets nothing, and the queued notice is withdrawn', async () => {
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain(); // queued, not sent
      await extend();
      await settleOthers([]);
      requests = [];
      await dispatch();
      expect(sentTo('bp1@test.local', /^(Please choose a new time|No action needed)/)).toEqual([]);
      expect((await notices('needs-new-time')).map((row) => row.status)).toEqual(['CANCELLED']);
      expect(await notices('appointment-restored')).toEqual([]);
    });

    it('does not send "valid again" if the appointment was cancelled in the meantime', async () => {
      const booked = (await book(0, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();
      await dispatch();
      await extend(); // "valid again" is queued
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(patientTokens[0])).send({}).expect(200);
      requests = [];
      await dispatch();
      expect(sentTo('bp1@test.local', /^No action needed/)).toEqual([]);
      expect((await notices('appointment-restored'))[0]).toMatchObject({ status: 'CANCELLED' });
      expect((await notices('appointment-restored'))[0].last_error).toMatch(/^Not sent: the appointment is cancelled/);
      expect(sentTo('bp1@test.local', /^Appointment cancelled/)).toHaveLength(1); // the cancellation itself is still sent
    });

    it('does not send "valid again" if the hours were reduced again before it went out', async () => {
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      await dispatch();
      await extend(); // queued
      await shrink(); // outside the hours once more, before the message went
      requests = [];
      await dispatch();
      expect(sentTo('bp1@test.local', /^No action needed/)).toEqual([]);
      expect((await notices('appointment-restored'))[0].last_error).toMatch(/outside the doctor's hours again/);
    });

    it('does not send a "choose a new time" email to a patient who already rescheduled', async () => {
      const booked = (await book(0, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();
      await http().post(`/api/appointments/${booked.id}/reschedule`).set(as(patientTokens[0])).send({ date: addDays(monday, 7), startTime: '10:00' }).expect(201);
      requests = [];
      await dispatch();
      expect(sentTo('bp1@test.local', /^Please choose a new time/)).toEqual([]);
    });

    describe('reliability', () => {
      it('never sends the same message twice: dispatching again, or replaying the event, adds nothing', async () => {
        const booked = (await book(0, monday, '11:00').expect(201)).body;
        await dispatch();
        const sent = requests.length;
        expect(sent).toBeGreaterThan(0);
        await dispatch();
        await dispatch();
        await app.get(NotificationsService).bookingConfirmed(app.get(DataSource).manager, booked.id);
        await dispatch();
        expect(requests).toHaveLength(sent);
        expect(await rows("SELECT count(*)::int AS n FROM notifications WHERE kind = 'booking-confirmed' AND channel = 'email'")).toEqual([{ n: 2 }]); // one for the patient, one for the doctor
      });

      it('keeps the booking and retries later when Brevo is down; one message arrives once it recovers', async () => {
        respond = () => ({ status: 503, body: { code: 'service_unavailable', message: 'Brevo is busy' } });
        const booked = (await book(0, monday, '11:00').expect(201)).body; // the booking is not held up by email
        expect(booked.status).toBe('CONFIRMED');
        await settleOthers(['booking-confirmed']);
        await db.query("UPDATE notifications SET status = 'SENT' WHERE kind = 'booking-confirmed' AND recipient_role = 'DOCTOR'");
        await dispatch();
        const [failed] = await notices('booking-confirmed').then((all) => all.filter((row) => row.status !== 'SENT'));
        expect(failed).toMatchObject({ status: 'PENDING', attempts: 1 });
        expect(failed.last_error).toBe('Brevo responded with HTTP 503 (service_unavailable: Brevo is busy)');
        expect(failed.last_error).not.toContain(KEY);

        await dispatch(); // too soon: backoff
        expect(requests).toHaveLength(1);
        respond = () => ({ status: 201, body: {} });
        await dispatch(new Date(Date.now() + 3_600_000)); // after the wait
        expect(requests).toHaveLength(2);
        expect((await notices('booking-confirmed')).filter((row) => row.status === 'SENT')).toHaveLength(2);
      });

      it('retries a rate limit too, then gives up after the configured number of attempts, keeping the reason', async () => {
        respond = () => ({ status: 429, body: { code: 'too_many_requests', message: 'Rate limit' } });
        await book(0, monday, '11:00').expect(201);
        await db.query("UPDATE notifications SET status = 'SENT' WHERE recipient_role = 'DOCTOR'");
        let at = Date.now();
        for (let attempt = 0; attempt < 8; attempt++) {
          await dispatch(new Date(at));
          at += 24 * 3_600_000;
        }
        const [row] = await notices('booking-confirmed').then((all) => all.filter((r) => r.status !== 'SENT'));
        expect(row).toMatchObject({ status: 'FAILED', attempts: 5 });
        expect(row.last_error).toContain('HTTP 429');
        expect(sentTo('bp1@test.local', /^Appointment confirmed/)).toHaveLength(5); // it stopped asking after the fifth try
      });

      it('an invalid recipient is refused for good without trying again, and does not stop other messages', async () => {
        await db.query("UPDATE users SET email = 'not an address' WHERE email = 'bp1@test.local'");
        try {
          await book(0, monday, '11:00').expect(201);
          await dispatch();
          await dispatch(new Date(Date.now() + 3_600_000));
          const [patientCopy] = await notices('booking-confirmed').then((all) => all.filter((row) => row.status === 'FAILED'));
          expect(patientCopy).toMatchObject({ status: 'FAILED', attempts: 1 });
          expect(patientCopy.last_error).toBe('The recipient address is not a valid email address.');
          expect(sentTo('not an address')).toEqual([]);
          expect(sentTo('brevo-doc@test.local', /^New booking/)).toHaveLength(1); // the doctor's copy was still delivered
        } finally {
          await db.query("UPDATE users SET email = 'bp1@test.local' WHERE email = 'not an address'");
        }
      });

      it("a recipient Brevo itself rejects (HTTP 400) fails once with Brevo's reason", async () => {
        respond = () => ({ status: 400, body: { code: 'invalid_parameter', message: 'valid email is required for to' } });
        await book(0, monday, '11:00').expect(201);
        await db.query("UPDATE notifications SET status = 'SENT' WHERE recipient_role = 'DOCTOR'");
        await dispatch();
        await dispatch(new Date(Date.now() + 3_600_000));
        const [row] = await notices('booking-confirmed').then((all) => all.filter((r) => r.status !== 'SENT'));
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
        expect(row.last_error).toBe('Brevo responded with HTTP 400 (invalid_parameter: valid email is required for to)');
      });

      it('a refused key or sender fails once and is kept for a person to look at; the failed message can be re-queued', async () => {
        respond = () => ({ status: 401, body: { code: 'unauthorized', message: 'Key not found' } });
        await book(0, monday, '11:00').expect(201);
        await db.query("UPDATE notifications SET status = 'SENT' WHERE recipient_role = 'DOCTOR'");
        await dispatch();
        const [row] = await notices('booking-confirmed').then((all) => all.filter((r) => r.status !== 'SENT'));
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
        respond = () => ({ status: 201, body: {} });
        const id = (await rows<{ id: string }>("SELECT id FROM notifications WHERE status = 'FAILED'"))[0].id;
        await app.get(NotificationsService).requeueFailed(id);
        await dispatch(new Date(Date.now() + 60_000)); // due by the database's clock, so ask a little later
        expect((await notices('booking-confirmed')).every((r) => r.status === 'SENT')).toBe(true);
      });

      it('logs each delivery by id and reference only: never the key, the address or the message', async () => {
        const logs: string[] = [];
        for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void logs.push(String(message)));
        await book(0, monday, '11:00').expect(201);
        await dispatch();
        respond = () => ({ status: 401, body: { code: 'unauthorized', message: 'Key not found' } });
        await book(1, monday, '11:30').expect(201);
        await dispatch();
        expect(logs.some((line) => /^Sent booking-confirmed by email: notification [0-9a-f-]+, reference <msg-/.test(line))).toBe(true);
        expect(logs.some((line) => /Could not send booking-confirmed by email \(attempt 1, giving up\): Brevo responded with HTTP 401/.test(line))).toBe(true);
        const everything = logs.join('\n');
        expect(everything).not.toContain(KEY);
        expect(everything).not.toMatch(/@test\.local/);
        expect(everything).not.toContain('Your appointment is confirmed');
      });
    });
  });

  describe('with Brevo not configured (no API key)', () => {
    beforeAll(async () => {
      await start(new DisabledEmailSender('BREVO_API_KEY is not set.'));
    });
    afterAll(async () => {
      await app?.close();
    });
    beforeEach(async () => {
      await clean();
      await addRow();
    });

    it('does not block booking; the notice is kept as FAILED with the reason, tried once, and nothing reaches Brevo', async () => {
      const booked = (await book(0, monday, '11:00').expect(201)).body;
      expect(booked.status).toBe('CONFIRMED');
      await dispatch();
      await dispatch(new Date(Date.now() + 3_600_000));
      const all = await notices('booking-confirmed');
      expect(all.length).toBeGreaterThan(0);
      for (const row of all) {
        expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
        expect(row.last_error).toBe('Email is not configured: BREVO_API_KEY is not set.');
      }
      expect(requests).toEqual([]);
    });
  });
});
