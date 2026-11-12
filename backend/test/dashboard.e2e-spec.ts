// Phase F: the doctor's dashboard and unresolved-appointment management, and one consistent suggestion for patients per slot.
//  - GET /doctor-portal/attention counts what needs the doctor: patients needing a new time, with no response after both reminders, with no other time open;
//  - the outside-hours list says where each patient stands (not asked / waiting / no response / no alternatives) and how many reminders were sent;
//  - the availability response carries ONE suggested patients-per-slot, taken from the doctor's own sessions, so new sessions start consistent.
// The mail provider is mocked.


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

describe('Doctor dashboard and unresolved appointments (e2e)', () => {
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

  /** Ankur-style setup: a session on day(6), one patient at 09:00 who is then affected when the doctor starts the day at 09:30. */
  const affectedPatient = async () => {
    const row = await session(day(6));
    const booked = (await book(0, day(6), '09:00').expect(201)).body;
    await change(row, '09:30', '10:00', { startTime: '09:00', endTime: '10:00' }).expect(200);
    await notifier().drain();
    return { row, booked };
  };

  const attention = async () => (await http().get('/api/doctor-portal/attention').set(as(doctorToken)).expect(200)).body as { needsNewTime: number; noResponse: number; noAlternatives: number };
  const outside = async () => (await http().get('/api/doctor-portal/appointments/outside-hours').set(as(doctorToken)).expect(200)).body.appointments as { id: string; followUp: { state: string; reminders: number } }[];

  /** Two other patients take both places left on the day, so the affected patient has nowhere to go. */
  const fillTheDay = async () => {
    await book(1, day(6), '09:30').expect(201);
    await book(2, day(6), '09:30').expect(201);
  };

  describe('attention counts', () => {
    it('is all zero with nothing unresolved, and needs the doctor role', async () => {
      expect(await attention()).toEqual({ needsNewTime: 0, noResponse: 0, noAlternatives: 0 });
      await http().get('/api/doctor-portal/attention').set(as(patientTokens[0])).expect(403);
      await http().get('/api/doctor-portal/attention').expect(401);
    });

    it('counts a patient who needs a new time, and drops them once they move', async () => {
      const { booked } = await affectedPatient();
      await session(day(7), { start: '09:00', end: '10:00', perSlot: 2 });
      expect(await attention()).toMatchObject({ needsNewTime: 1, noResponse: 0 });
      await reschedule(0, booked.id, day(7), '09:00').expect(201);
      expect(await attention()).toEqual({ needsNewTime: 0, noResponse: 0, noAlternatives: 0 });
    });

    it('reports no response only after both reminders and the cooldown', async () => {
      await affectedPatient();
      await age(25);
      await notifier().remind();
      await age(25);
      await notifier().remind();
      expect((await attention()).noResponse).toBe(0); // the second reminder was just sent
      await age(25);
      expect(await attention()).toMatchObject({ needsNewTime: 1, noResponse: 1 });
    });

    it('counts a patient with no other time open, until new availability appears and they are told', async () => {
      await affectedPatient();
      await fillTheDay();
      await notifier().recover();
      expect((await attention()).noAlternatives).toBe(1);
      await session(day(8), { start: '09:00', end: '10:00', perSlot: 2 });
      await notifier().recover();
      expect((await attention()).noAlternatives).toBe(0);
    });
  });

  describe('where each unresolved patient stands', () => {
    it('shows not asked, waiting, no response and no alternatives, with the reminder count', async () => {
      const { booked } = await affectedPatient();
      await session(day(8), { start: '09:00', end: '10:00', perSlot: 2 });
      let list = await outside();
      expect(list.find((a) => a.id === booked.id)?.followUp).toMatchObject({ state: 'WAITING', reminders: 0 });
      await age(25);
      await notifier().remind();
      await age(25);
      await notifier().remind();
      await age(25);
      list = await outside();
      expect(list.find((a) => a.id === booked.id)?.followUp).toEqual(expect.objectContaining({ state: 'NO_RESPONSE', reminders: 2 }));
      await db.query('DELETE FROM availability WHERE specific_date = $1', [day(8)]);
      await fillTheDay();
      list = await outside();
      expect(list.find((a) => a.id === booked.id)?.followUp.state).toBe('NO_ALTERNATIVES');
    });

    it('says not asked for an appointment stranded without any message', async () => {
      const { booked } = await affectedPatient();
      await db.query("DELETE FROM notifications WHERE kind = 'needs-new-time'");
      await session(day(8), { start: '09:00', end: '10:00', perSlot: 2 });
      expect((await outside()).find((a) => a.id === booked.id)?.followUp.state).toBe('NOT_ASKED');
    });
  });

  describe('consistent capacity default', () => {
    const suggested = async () => (await http().get('/api/doctor-portal/availability').set(as(doctorToken)).expect(200)).body.suggestedCapacityPerSlot as number;
    it('is 3 with no sessions, then follows what the doctor already uses', async () => {
      expect(await suggested()).toBe(3);
      await session(day(3), { perSlot: 5 });
      await session(day(4), { perSlot: 5 });
      await session(day(5), { perSlot: 2 });
      expect(await suggested()).toBe(5);
    });
    it('ignores sessions in the past or ended', async () => {
      await db.query(`INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes, effective_to)
        VALUES ($1, 'WEEKLY', 2, '09:00', '10:00', 'WAVE', 9, 30, $2)`, [doctorId, day(-3)]);
      expect(await suggested()).toBe(3);
    });
  });
});
