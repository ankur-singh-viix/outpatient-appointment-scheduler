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
let dayCounter = 0;
const nextDay = () => addDays(today, 2 + (dayCounter++ % 25));

interface SlotView {
  startTime: string;
  endTime: string;
  status: string;
}

describe('Slot windows, intervals and overlap protection (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let overlapDoctorId: string; // 30-minute appointments, a new slot every 15 minutes, 11:00-12:30
  let legacyDoctorId: string; // 20-minute appointments, no interval set: slots follow one another
  let overlapDoctorToken: string;
  let patientToken: string;
  let otherPatientToken: string;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (token: string, date: string, startTime: string, doctorId = overlapDoctorId) =>
    http().post('/api/appointments').set(as(token)).send({ doctorId, date, startTime });
  const day = async (date: string, doctorId = overlapDoctorId) => (await http().get(`/api/doctors/${doctorId}/slots`).query({ date }).expect(200)).body as { slots: SlotView[]; slotIntervalMinutes: number; consultationMinutes: number; sessions: { booked: number; remaining: number }[] };
  const statuses = async (date: string, doctorId = overlapDoctorId) => Object.fromEntries((await day(date, doctorId)).slots.map((slot) => [slot.startTime, slot.status]));

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
    const makeDoctor = async (name: string, email: string, minutes: number, interval: number | null) => {
      const userId = await user(name, email, 'DOCTOR');
      const id = (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, slot_interval_minutes, default_daily_capacity, consultation_fee)
           VALUES ($1, $2, $3, $4, $5, 10, 0) RETURNING id`,
          [userId, clinicId, specialtyId, minutes, interval],
        )
      ).rows[0].id as string;
      for (let dow = 0; dow < 7; dow++) {
        await db.query("INSERT INTO availability (doctor_id, day_of_week, start_time, end_time, capacity) VALUES ($1, $2, '11:00', '12:30', 10)", [id, dow]);
      }
      return id;
    };
    overlapDoctorId = await makeDoctor('Dr. Overlap', 'overlap@test.local', 30, 15);
    legacyDoctorId = await makeDoctor('Dr. Legacy', 'legacy@test.local', 20, null);
    for (const [name, email] of [['Pat One', 'patient1@test.local'], ['Pat Two', 'patient2@test.local']]) {
      const id = await user(name, email, 'PATIENT');
      await db.query('INSERT INTO patients (user_id) VALUES ($1)', [id]);
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => undefined }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    patientToken = await login('patient1@test.local');
    otherPatientToken = await login('patient2@test.local');
    overlapDoctorToken = await login('overlap@test.local');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments;');
    await db.query('UPDATE doctors SET consultation_minutes = 30, slot_interval_minutes = 15 WHERE id = $1', [overlapDoctorId]);
  });

  describe('listing slots', () => {
    it('returns overlapping windows, each with a start and an end time', async () => {
      const result = await day(nextDay());
      expect(result.consultationMinutes).toBe(30);
      expect(result.slotIntervalMinutes).toBe(15);
      expect(result.slots).toEqual([
        { startTime: '11:00', endTime: '11:30', status: 'AVAILABLE' },
        { startTime: '11:15', endTime: '11:45', status: 'AVAILABLE' },
        { startTime: '11:30', endTime: '12:00', status: 'AVAILABLE' },
        { startTime: '11:45', endTime: '12:15', status: 'AVAILABLE' },
        { startTime: '12:00', endTime: '12:30', status: 'AVAILABLE' },
      ]);
    });

    it('keeps a doctor with no interval set on back-to-back slots, exactly as before', async () => {
      const result = await day(nextDay(), legacyDoctorId);
      expect(result.slotIntervalMinutes).toBe(20);
      expect(result.slots.map((slot) => `${slot.startTime}-${slot.endTime}`)).toEqual(['11:00-11:20', '11:20-11:40', '11:40-12:00', '12:00-12:20']);
    });

    it('shows the interval on the doctor list and detail as well', async () => {
      const list = (await http().get('/api/doctors').expect(200)).body as { id: string; consultationMinutes: number; slotIntervalMinutes: number }[];
      expect(list.find((doctor) => doctor.id === overlapDoctorId)).toMatchObject({ consultationMinutes: 30, slotIntervalMinutes: 15 });
      expect(list.find((doctor) => doctor.id === legacyDoctorId)).toMatchObject({ consultationMinutes: 20, slotIntervalMinutes: 20 });
      expect((await http().get(`/api/doctors/${overlapDoctorId}`).expect(200)).body).toMatchObject({ slotIntervalMinutes: 15 });
    });
  });

  describe('booking and overlap prevention', () => {
    it('stores both the start and the end time of the booking', async () => {
      const date = nextDay();
      const response = await book(patientToken, date, '11:15').expect(201);
      expect(response.body).toMatchObject({ startTime: '11:15', endTime: '11:45' });
      expect(await rows('SELECT start_time, end_time FROM appointments WHERE id = $1', [response.body.id])).toEqual([{ start_time: '11:15:00', end_time: '11:45:00' }]);
    });

    it('blocks every window that overlaps a booking, and only those', async () => {
      const date = nextDay();
      await book(patientToken, date, '11:15').expect(201); // 11:15-11:45
      expect(await statuses(date)).toEqual({ '11:00': 'BOOKED', '11:15': 'BOOKED', '11:30': 'BOOKED', '11:45': 'AVAILABLE', '12:00': 'AVAILABLE' });

      for (const startTime of ['11:00', '11:15', '11:30']) {
        const refused = await book(otherPatientToken, date, startTime).expect(409);
        expect(refused.body.message).toMatch(/just been booked/i);
      }
      // 11:45-12:15 starts exactly when the booking ends: allowed.
      await book(otherPatientToken, date, '11:45').expect(201);
    });

    it('lets a booking that ends exactly when another starts sit beside it', async () => {
      const date = nextDay();
      await book(patientToken, date, '11:00').expect(201); // 11:00-11:30
      await book(otherPatientToken, date, '11:30').expect(201); // 11:30-12:00
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CONFIRMED'")).toEqual([{ n: 2 }]);
    });

    it('refuses an overlapping booking made at the very same moment: exactly one wins', async () => {
      const date = nextDay();
      const results = await Promise.all([book(patientToken, date, '11:00'), book(otherPatientToken, date, '11:15')]);
      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([201, 409]);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status IN ('PENDING','CONFIRMED')")).toEqual([{ n: 1 }]);
    });

    it('frees every overlapped window when the booking is cancelled', async () => {
      const date = nextDay();
      const booked = (await book(patientToken, date, '11:15').expect(201)).body;
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(patientToken)).send({}).expect(200);
      expect(Object.values(await statuses(date)).every((status) => status === 'AVAILABLE')).toBe(true);
      await book(otherPatientToken, date, '11:30').expect(201);
    });

    it('treats an unpaid payment hold (PENDING) as occupying its time', async () => {
      const date = nextDay();
      const patient = (await rows<{ id: string; user_id: string }>("SELECT p.id, p.user_id FROM patients p JOIN users u ON u.id = p.user_id WHERE u.email = 'patient1@test.local'"))[0];
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, hold_expires_at)
         VALUES ($1, $2, $3, $4, '11:15', '11:45', 'PENDING', now() + interval '10 minutes')`,
        [patient.id, overlapDoctorId, patient.user_id, date],
      );
      expect((await statuses(date))['11:30']).toBe('BOOKED');
      await book(otherPatientToken, date, '11:30').expect(409);
    });

    it('keeps one doctor’s bookings from blocking another doctor’s slots', async () => {
      const date = nextDay();
      await book(patientToken, date, '11:00').expect(201);
      await book(otherPatientToken, date, '11:00', legacyDoctorId).expect(201);
    });

    it('lets the same patient hold overlapping times with two different doctors (the rule is per doctor)', async () => {
      const date = nextDay();
      await book(patientToken, date, '11:00').expect(201);
      await book(patientToken, date, '11:00', legacyDoctorId).expect(201);
    });
  });

  describe('the database backstop', () => {
    const insertAppointment = async (startTime: string, endTime: string, date: string, status = 'CONFIRMED') => {
      const patient = (await rows<{ id: string; user_id: string }>('SELECT id, user_id FROM patients LIMIT 1'))[0];
      return db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [patient.id, overlapDoctorId, patient.user_id, date, startTime, endTime, status],
      );
    };

    it('rejects overlapping active appointments even if the application is bypassed', async () => {
      const date = nextDay();
      await insertAppointment('11:00', '11:30', date);
      await expect(insertAppointment('11:15', '11:45', date)).rejects.toMatchObject({ code: '23P01' });
      await expect(insertAppointment('10:45', '11:15', date)).rejects.toMatchObject({ code: '23P01' });
      await expect(insertAppointment('11:05', '11:10', date)).rejects.toMatchObject({ code: '23P01' }); // fully inside
    });

    it('allows back-to-back appointments, cancelled overlaps, and the same time on another day', async () => {
      const date = nextDay();
      await insertAppointment('11:00', '11:30', date);
      await insertAppointment('11:30', '12:00', date); // starts as the first ends
      await insertAppointment('11:15', '11:45', date, 'CANCELLED').catch(() => undefined);
      await insertAppointment('11:00', '11:30', addDays(date, 1));
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CONFIRMED'")).toEqual([{ n: 3 }]);
    });
  });

  describe('rescheduling', () => {
    it('refuses a move into a window that overlaps someone else', async () => {
      const date = nextDay();
      const mine = (await book(patientToken, date, '11:00').expect(201)).body;
      await book(otherPatientToken, date, '12:00').expect(201); // 12:00-12:30
      await http().post(`/api/appointments/${mine.id}/reschedule`).set(as(patientToken)).send({ date, startTime: '11:45' }).expect(409); // 11:45-12:15 overlaps 12:00-12:30
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CONFIRMED' }]); // untouched
    });

    it('allows a move that overlaps only the appointment being moved', async () => {
      const date = nextDay();
      const mine = (await book(patientToken, date, '11:00').expect(201)).body; // 11:00-11:30
      const moved = await http().post(`/api/appointments/${mine.id}/reschedule`).set(as(patientToken)).send({ date, startTime: '11:15' }).expect(201); // 11:15-11:45
      expect(moved.body).toMatchObject({ startTime: '11:15', endTime: '11:45' });
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CANCELLED' }]);
    });
  });

  describe('existing appointments', () => {
    it('stay visible and keep blocking time after the schema change, whatever their length', async () => {
      const date = nextDay();
      const patient = (await rows<{ id: string; user_id: string }>('SELECT id, user_id FROM patients LIMIT 1'))[0];
      // A booking made before overlapping slots existed: the legacy doctor's 20-minute slot.
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, '11:20', '11:40', 'CONFIRMED')`,
        [patient.id, legacyDoctorId, patient.user_id, date],
      );
      expect(await statuses(date, legacyDoctorId)).toEqual({ '11:00': 'AVAILABLE', '11:20': 'BOOKED', '11:40': 'AVAILABLE', '12:00': 'AVAILABLE' });
      const mine = (await http().get('/api/appointments/mine').set(as(patientToken)).expect(200)).body as { startTime: string; endTime: string; status: string }[];
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ startTime: '11:20', endTime: '11:40', status: 'CONFIRMED' });
    });

    it('still block overlapping windows if the doctor later changes to a different interval', async () => {
      const date = nextDay();
      await book(patientToken, date, '11:00').expect(201); // 11:00-11:30 under 30/15
      await db.query('UPDATE doctors SET consultation_minutes = 20, slot_interval_minutes = 10 WHERE id = $1', [overlapDoctorId]);
      // Now 20-minute slots every 10 minutes: 11:10-11:30 would overlap the existing booking.
      const result = await statuses(date);
      expect(result['11:10']).toBe('BOOKED');
      expect(result['11:20']).toBe('BOOKED');
      expect(result['11:30']).toBe('AVAILABLE');
      await book(otherPatientToken, date, '11:10').expect(409);
    });
  });

  describe('the doctor settings', () => {
    const settings = (body: object) => http().put('/api/doctor-portal/settings').set(as(overlapDoctorToken)).send(body);
    const availability = async () => (await http().get('/api/doctor-portal/availability').set(as(overlapDoctorToken)).expect(200)).body;

    it('shows the current length and interval', async () => {
      expect(await availability()).toMatchObject({ consultationMinutes: 30, slotIntervalMinutes: 15, slotIntervalCustom: true });
    });

    it('changes the interval, which patients see straight away', async () => {
      await settings({ slotIntervalMinutes: 30 }).expect(200);
      const date = nextDay();
      expect((await day(date)).slots.map((slot) => slot.startTime)).toEqual(['11:00', '11:30', '12:00']);
    });

    it('lets the interval change even with upcoming appointments, without disturbing them', async () => {
      const date = nextDay();
      const booked = (await book(patientToken, date, '11:00').expect(201)).body;
      await settings({ slotIntervalMinutes: 10 }).expect(200);
      expect(await rows('SELECT start_time, end_time, status FROM appointments WHERE id = $1', [booked.id])).toEqual([{ start_time: '11:00:00', end_time: '11:30:00', status: 'CONFIRMED' }]);
      expect((await statuses(date))['11:20']).toBe('BOOKED'); // 11:20-11:50 overlaps 11:00-11:30
      expect((await statuses(date))['11:30']).toBe('AVAILABLE');
    });

    it('still refuses a change of appointment length while appointments are upcoming', async () => {
      await book(patientToken, nextDay(), '11:00').expect(201);
      const refused = await settings({ consultationMinutes: 20 }).expect(409);
      expect(refused.body.message).toMatch(/upcoming appointment/i);
      expect(await availability()).toMatchObject({ consultationMinutes: 30 });
    });

    it('changes both at once, and resets the interval to follow the length with null', async () => {
      await settings({ consultationMinutes: 20, slotIntervalMinutes: 10 }).expect(200);
      expect(await availability()).toMatchObject({ consultationMinutes: 20, slotIntervalMinutes: 10, slotIntervalCustom: true });
      await settings({ slotIntervalMinutes: null }).expect(200);
      expect(await availability()).toMatchObject({ consultationMinutes: 20, slotIntervalMinutes: 20, slotIntervalCustom: false });
    });

    it('validates what it is sent', async () => {
      await settings({}).expect(400);
      await settings({ slotIntervalMinutes: 3 }).expect(400);
      await settings({ slotIntervalMinutes: 500 }).expect(400);
      await settings({ slotIntervalMinutes: 12.5 }).expect(400);
      await settings({ consultationMinutes: 0 }).expect(400);
      await settings({ unknown: 1 }).expect(400);
    });

    it('is only available to doctors', async () => {
      await http().put('/api/doctor-portal/settings').set(as(patientToken)).send({ slotIntervalMinutes: 10 }).expect(403);
      await http().put('/api/doctor-portal/settings').send({ slotIntervalMinutes: 10 }).expect(401);
    });

    it('shows the doctor both times of every appointment', async () => {
      const date = nextDay();
      await book(patientToken, date, '11:15').expect(201);
      const list = (await http().get('/api/doctor-portal/appointments').query({ scope: 'all' }).set(as(overlapDoctorToken)).expect(200)).body as { startTime: string; endTime: string }[];
      expect(list[0]).toMatchObject({ startTime: '11:15', endTime: '11:45' });
    });
  });
});
