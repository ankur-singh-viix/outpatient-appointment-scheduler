// Phase E: CareSlot coordinates the affected patients so the doctor does not have to.
//  - an unresolved patient gets at most TWO automatic reminders, a cooldown apart, each one a recorded notification (so each is auditable);
//  - reminders stop the moment the patient reschedules, cancels, or the appointment is valid again, and a queued one is never sent after that;
//  - a patient who has NO alternative is recorded as such, and is emailed exactly once when suitable availability appears;
//  - patients who always had alternatives are never nagged; nothing is ever cancelled or reserved on anyone's behalf.
// The mail provider is mocked: nothing here leaves the test database.

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
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';
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
process.env.SCHEDULE_REMINDER_COOLDOWN_HOURS = '24';

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);
const PATIENTS = 12;
const REQUESTS = "('needs-new-time', 'needs-new-time-reminder', 'new-times-available')";

describe('Coordinating affected patients automatically (e2e)', () => {
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
  const notifier = () => app.get(ScheduleChangeNotifier);
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
  const change = (id: string, startTime: string, endTime: string, from: { startTime: string; endTime: string }) =>
    http().post(`/api/doctor-portal/availability/${id}/change`).set(as(doctorToken)).send({ startTime, endTime, from, acknowledge: true });
  /** Moves the clock forward for the coordination records: every contact looks `hours` older. */
  const age = async (hours: number) => {
    await db.query("UPDATE schedule_change_appointments SET notified_at = notified_at - ($1 || ' hours')::interval WHERE notified_at IS NOT NULL", [String(hours)]);
    await db.query(`UPDATE notifications SET created_at = created_at - ($1 || ' hours')::interval WHERE kind IN ${REQUESTS} OR kind = 'no-alternatives'`, [String(hours)]);
  };
  const messages = (kind: string) => rows<{ appointment_id: string; status: string; subject: string; dedupe_key: string; to_address: string }>('SELECT appointment_id, status, subject, dedupe_key, to_address FROM notifications WHERE kind = $1 ORDER BY created_at, dedupe_key', [kind]);
  const status = (id: string) => rows<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [id]).then((r) => r[0].status);
  const dispatch = async () => {
    sent.length = 0;
    await db.query("UPDATE notifications SET status = 'SENT' WHERE status = 'PENDING' AND kind NOT IN ('needs-new-time', 'needs-new-time-reminder', 'new-times-available')");
    await app.get(NotificationsService).dispatchDue(new Date(Date.now() + 60_000), 200);
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

  /** Ankur-style setup: a session on day(6), one patient at 09:00 who is then affected when the doctor starts the day at 09:30. */
  const affectedPatient = async () => {
    const row = await session(day(6));
    const booked = (await book(0, day(6), '09:00').expect(201)).body;
    await change(row, '09:30', '10:00', { startTime: '09:00', endTime: '10:00' }).expect(200);
    await notifier().drain();
    return { row, booked };
  };

  describe('reminders: at most two, a cooldown apart, each one recorded', () => {
    it('sends reminder 1 and reminder 2 only after the cooldown, never a third, and never changes the appointment', async () => {
      const { booked } = await affectedPatient();
      expect(await messages('needs-new-time')).toHaveLength(1);

      expect(await notifier().remind()).toBe(0); // too soon: the first message was just queued
      await age(25);
      expect(await notifier().remind()).toBe(1);
      expect(await notifier().remind()).toBe(0); // the cooldown starts again from the reminder
      await age(25);
      expect(await notifier().remind()).toBe(1);
      await age(25);
      expect(await notifier().remind()).toBe(0); // the policy is two, then the doctor's list says "no response"

      const reminders = await messages('needs-new-time-reminder');
      expect(reminders).toHaveLength(2);
      expect(reminders.map((r) => r.subject)).toEqual([expect.stringMatching(/Reminder 1 of 2/), expect.stringMatching(/Reminder 2 of 2/)]);
      expect(new Set(reminders.map((r) => r.dedupe_key)).size).toBe(2);
      expect(reminders.every((r) => r.to_address === 'co1@test.local')).toBe(true); // the address comes from the patient's account
      expect(await status(booked.id)).toBe('CONFIRMED'); // never cancelled for not answering
    });

    it('two servers running the reminder job at the same moment still send one reminder', async () => {
      await affectedPatient();
      await age(25);
      const results = await Promise.all([notifier().remind(), notifier().remind(), notifier().remind()]);
      expect(results.reduce((sum, n) => sum + n, 0)).toBe(1);
      expect(await messages('needs-new-time-reminder')).toHaveLength(1);
    });

    it('a reminder goes out by email like any other message, with the link to choose a time', async () => {
      const { booked } = await affectedPatient();
      await age(25);
      await notifier().remind();
      await dispatch();
      const mail = sent.find((m) => /Reminder 1 of 2/.test(m.subject));
      expect(mail).toMatchObject({ to: 'co1@test.local' });
      expect((await messages('needs-new-time-reminder'))[0].status).toBe('SENT');
      expect(booked.id).toBeTruthy();
    });
  });

  describe('reminders stop when they should', () => {
    it('after the patient reschedules: no more reminders, and one already queued is not sent', async () => {
      const { booked } = await affectedPatient();
      await age(25);
      await notifier().remind();
      expect(await messages('needs-new-time-reminder')).toHaveLength(1);
      await reschedule(0, booked.id, day(6), '09:30').expect(201);
      await dispatch();
      expect((await messages('needs-new-time-reminder'))[0].status).toBe('CANCELLED'); // stale: the appointment moved
      expect(sent.filter((m) => /Reminder/.test(m.subject))).toEqual([]);
      await notifier().drain();
      await age(25);
      expect(await notifier().remind()).toBe(0);
    });

    it('after the patient cancels', async () => {
      const { booked } = await affectedPatient();
      await age(25);
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(patientTokens[0])).send({ reason: 'test' }).expect(200);
      await notifier().drain();
      expect(await notifier().remind()).toBe(0);
      await dispatch();
      expect(sent.filter((m) => /Reminder|choose a new time/i.test(m.subject))).toEqual([]);
    });

    it('when the doctor widens the hours so the appointment is valid again: a queued reminder is withdrawn and none follows', async () => {
      const { booked } = await affectedPatient();
      await age(25);
      await notifier().remind();
      const current = (await rows<{ id: string }>("SELECT id FROM availability WHERE specific_date = $1", [day(6)]))[0].id;
      await change(current, '09:00', '10:00', { startTime: '09:30', endTime: '10:00' }).expect(200);
      expect((await messages('needs-new-time-reminder'))[0].status).toBe('CANCELLED');
      await age(25);
      expect(await notifier().remind()).toBe(0);
      expect(await status(booked.id)).toBe('CONFIRMED');
    });

    it('a patient who already moved is not reminded even if the sweep has not closed the record yet', async () => {
      const { booked } = await affectedPatient();
      await reschedule(0, booked.id, day(6), '09:30').expect(201);
      await age(25);
      expect(await notifier().remind()).toBe(0); // the old appointment is no longer active
    });
  });

  describe('recovery: a patient with no alternative is told once when suitable availability appears', () => {
    /** Ankur and Rahul share 09:00 (2 of 2); Rudra is at 09:30. The doctor starts the day at 09:30, so Ankur and Rahul need a new time, and there is one place. */
    const rahulsDay = async () => {
      const row = await session(day(6));
      const ankur = (await book(0, day(6), '09:00').expect(201)).body;
      const rahul = (await book(1, day(6), '09:00').expect(201)).body;
      await book(2, day(6), '09:30').expect(201);
      await change(row, '09:30', '10:00', { startTime: '09:00', endTime: '10:00' }).expect(200);
      await notifier().drain();
      return { ankur, rahul };
    };

    it('Rahul has no time left after Ankur takes the last place: he stays booked, is recorded as having no alternative, and is emailed once when the doctor adds a session', async () => {
      const { ankur, rahul } = await rahulsDay();
      expect(await messages('needs-new-time')).toHaveLength(2); // both were asked, each individually
      await reschedule(0, ankur.id, day(6), '09:30').expect(201); // the one open place goes to Ankur
      const alone = (await http().get(`/api/appointments/${rahul.id}/alternatives`).set(as(patientTokens[1])).expect(200)).body;
      expect(alone).toMatchObject({ needsNewTime: true, alternatives: [], nextCursor: null });

      await notifier().recover(doctorId);
      expect(await rows("SELECT status FROM notifications WHERE kind = 'no-alternatives'")).toEqual([{ status: 'CANCELLED' }]); // a record, never sent
      expect(await messages('new-times-available')).toEqual([]); // nothing new has opened yet
      expect(await status(rahul.id)).toBe('CONFIRMED');

      await session(day(8)); // the doctor adds a one-time session
      await notifier().recover(doctorId);
      const told = await messages('new-times-available');
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ appointment_id: rahul.id, to_address: 'co2@test.local', status: 'PENDING' });

      await notifier().recover(doctorId);
      await notifier().recover();
      expect(await messages('new-times-available')).toHaveLength(1); // never twice for the same gap

      // Rahul confirms his own new time; nothing was reserved or moved for him.
      const options = (await http().get(`/api/appointments/${rahul.id}/alternatives`).set(as(patientTokens[1])).expect(200)).body.alternatives as { date: string; startTime: string }[];
      expect(options[0]).toMatchObject({ date: day(8) });
      await reschedule(1, rahul.id, options[0].date, options[0].startTime).expect(201);
    });

    it('Ankur, who still had a place to go, is not told about the new session', async () => {
      const { ankur } = await rahulsDay();
      await notifier().recover(doctorId);
      await session(day(8));
      await notifier().recover(doctorId);
      expect((await messages('new-times-available')).filter((m) => m.appointment_id === ankur.id)).toEqual([]);
    });

    it('the message is checked again just before sending: if Rahul has meanwhile moved, it is not sent', async () => {
      const { ankur, rahul } = await rahulsDay();
      await reschedule(0, ankur.id, day(6), '09:30').expect(201);
      await notifier().recover(doctorId);
      await session(day(8));
      await notifier().recover(doctorId);
      const options = (await http().get(`/api/appointments/${rahul.id}/alternatives`).set(as(patientTokens[1])).expect(200)).body.alternatives as { date: string; startTime: string }[];
      await reschedule(1, rahul.id, options[0].date, options[0].startTime).expect(201);
      await dispatch();
      expect(sent.filter((m) => /New times are open/.test(m.subject))).toEqual([]);
      expect((await messages('new-times-available'))[0].status).toBe('CANCELLED');
    });

    it('a patient released by an expansion is not told about new availability either', async () => {
      const { rahul } = await rahulsDay();
      await reschedule(0, (await rows<{ id: string }>("SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id WHERE u.email = 'co1@test.local' AND a.status = 'CONFIRMED'"))[0].id, day(6), '09:30').expect(201);
      await notifier().recover(doctorId);
      const current = (await rows<{ id: string }>('SELECT id FROM availability WHERE specific_date = $1', [day(6)]))[0].id;
      await change(current, '09:00', '10:00', { startTime: '09:30', endTime: '10:00' }).expect(200); // valid again
      await session(day(8));
      await notifier().recover(doctorId);
      expect(await messages('new-times-available')).toEqual([]);
      expect(await status(rahul.id)).toBe('CONFIRMED');
    });
  });

  describe('six affected patients: one change, six records, individual messages, no automatic cancellation', () => {
    it('plays out with limited room: two patients compete for the last place, the others are recorded and recovered later', async () => {
      const row = await session(day(6), { perSlot: 6 });
      for (let n = 0; n < 6; n++) await book(n, day(6), '09:30').expect(201); // six patients at 09:30 (6 of 6)
      for (let n = 6; n < 11; n++) await book(n, day(6), '09:00').expect(201); // five at 09:00 (5 of 6): one place left
      await change(row, '09:00', '09:30', { startTime: '09:00', endTime: '10:00' }).expect(200); // the doctor ends the day at 09:30: six affected

      expect(await rows('SELECT count(*)::int AS n FROM schedule_change_appointments')).toEqual([{ n: 6 }]);
      await notifier().drain();
      const asked = await messages('needs-new-time');
      expect(asked).toHaveLength(6);
      expect(new Set(asked.map((m) => m.to_address)).size).toBe(6); // each patient got their own message, from their own account

      // Two of them race for the one place.
      const ids = await rows<{ id: string; email: string }>("SELECT a.id, u.email FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id WHERE a.start_time = '09:30' AND a.status = 'CONFIRMED' ORDER BY u.email");
      const byEmail = (email: string) => ids.find((r) => r.email === email)!.id;
      const race = await Promise.all([reschedule(0, byEmail('co1@test.local'), day(6), '09:00'), reschedule(1, byEmail('co2@test.local'), day(6), '09:00')]);
      expect(race.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE start_time = '09:00' AND status = 'CONFIRMED'")).toEqual([{ n: 6 }]); // never over capacity

      // Five are still waiting; none has any alternative.
      await notifier().drain();
      await notifier().recover(doctorId);
      expect((await rows("SELECT appointment_id FROM notifications WHERE kind = 'no-alternatives'")).length).toBe(5);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE start_time = '09:30' AND status = 'CONFIRMED'")).toEqual([{ n: 5 }]);

      // The doctor adds one session; every waiting patient is told once, and they choose for themselves.
      await session(day(9), { perSlot: 3 });
      await notifier().recover(doctorId);
      const told = await messages('new-times-available');
      expect(told).toHaveLength(5);
      expect(new Set(told.map((m) => m.to_address)).size).toBe(5);
      await notifier().recover(doctorId);
      expect(await messages('new-times-available')).toHaveLength(5);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CANCELLED' AND cancel_reason IS DISTINCT FROM 'Rescheduled by patient'")).toEqual([{ n: 0 }]);
    });
  });
});
