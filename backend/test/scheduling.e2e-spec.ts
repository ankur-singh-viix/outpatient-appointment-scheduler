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
import { addDays, clinicNow, dayOfWeek } from '../src/scheduling/calendar.js';

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
const nextDay = () => addDays(today, 2 + (dayCounter++ % 18));
const PATIENTS = 8;

interface SlotView {
  startTime: string;
  endTime: string;
  status: string;
  capacityPerSlot?: number;
  booked?: number;
  remaining?: number;
  mode?: string;
  availabilityId?: string | null;
}
interface DayView {
  slots: SlotView[];
  sessions: { source: string; capacity: number; booked: number; remaining: number }[];
  unavailableReason: string | null;
}

describe('Wave and stream scheduling (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string; // 30-minute slots
  let doctorToken: string;
  const patientTokens: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;

  const day = async (date: string, availableOnly = false) =>
    (await http().get(`/api/doctors/${doctorId}/slots`).query({ date, ...(availableOnly ? { availableOnly: 'true' } : {}) }).expect(200)).body as DayView;
  const starts = async (date: string, availableOnly = false) => (await day(date, availableOnly)).slots.map((slot) => slot.startTime);
  const book = (patient: number, date: string, startTime: string, extra: Record<string, unknown> = {}) =>
    http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime, ...extra });

  const putWeekly = (hours: unknown[]) => http().put('/api/doctor-portal/availability/weekly').set(as(doctorToken)).send({ hours });
  const postOneTime = (body: Record<string, unknown>) => http().post('/api/doctor-portal/availability/one-time').set(as(doctorToken)).send(body);
  const putOverride = (body: Record<string, unknown>) => http().put('/api/doctor-portal/availability/overrides').set(as(doctorToken)).send(body);
  const weeklyOn = (date: string, extra: Record<string, unknown> = {}) => ({ dayOfWeek: dayOfWeek(date), startTime: '09:00', endTime: '12:00', ...extra });

  const activeAppointments = (date: string) =>
    rows<{ start_time: string; slot_number: number; slot_capacity: number; availability_id: string | null }>(
      "SELECT start_time::text, slot_number, slot_capacity, availability_id FROM appointments WHERE appointment_date = $1 AND status IN ('PENDING','CONFIRMED') ORDER BY start_time, slot_number",
      [date],
    );

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
    const doctorUserId = await user('Dr. Wave', 'wave@test.local', 'DOCTOR');
    doctorId = (
      await db.query(
        `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
         VALUES ($1, $2, $3, 30, 20, 0) RETURNING id`,
        [doctorUserId, clinicId, specialtyId],
      )
    ).rows[0].id as string;
    for (let n = 1; n <= PATIENTS; n++) {
      const id = await user(`Patient ${n}`, `p${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id) VALUES ($1)', [id]);
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => undefined }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('wave@test.local');
    for (let n = 1; n <= PATIENTS; n++) patientTokens.push(await login(`p${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
  });

  describe('weekly availability', () => {
    it('is offered on its weekday only, in slots of the doctor\'s length', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      expect(await starts(date)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
      expect(await starts(addDays(date, 1))).toEqual([]);
    });

    it('stores the new columns with safe defaults: STREAM, one patient per slot', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date, { capacity: 4 })]).expect(200);
      const [row] = await rows('SELECT recurrence_type, scheduling_mode, capacity_per_slot, slot_duration_minutes, capacity, specific_date FROM availability');
      expect(row).toEqual({ recurrence_type: 'WEEKLY', scheduling_mode: 'STREAM', capacity_per_slot: 1, slot_duration_minutes: 30, capacity: 4, specific_date: null });
    });

    it('accepts the rows exactly as the availability endpoint returns them (what the doctor page sends back on save)', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date, { capacity: 4 })]).expect(200);
      await postOneTime({ date: addDays(date, 1), startTime: '14:00', endTime: '15:00', schedulingMode: 'WAVE', capacityPerSlot: 2 }).expect(201);
      const loaded = (await http().get('/api/doctor-portal/availability').set(as(doctorToken)).expect(200)).body.weekly as Record<string, unknown>[];
      expect(loaded[0]).toMatchObject({ id: expect.any(String), effectiveFrom: null, effectiveTo: null }); // the fields that once made a plain save fail
      await putWeekly(loaded).expect(200);
      expect((await rows("SELECT id FROM availability WHERE recurrence_type = 'WEEKLY'")).map((row) => row.id)).toEqual([loaded[0].id]); // unchanged row kept
      expect((await starts(date)).length).toBe(6);
    });

    it('does not offer a weekly row outside its effective dates', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date, { effectiveFrom: addDays(date, 1) })]).expect(200);
      expect(await starts(date)).toEqual([]);
      await putWeekly([weeklyOn(date, { effectiveFrom: date, effectiveTo: date })]).expect(200);
      expect((await starts(date)).length).toBe(6);
    });
  });

  describe('one-time availability', () => {
    it('applies to its date only and is listed in the doctor\'s availability', async () => {
      const date = nextDay();
      const created = await postOneTime({ date, startTime: '14:00', endTime: '15:00' }).expect(201);
      expect(created.body.oneTime).toMatchObject([{ date, startTime: '14:00', endTime: '15:00', schedulingMode: 'STREAM', capacityPerSlot: 1 }]);
      expect(await starts(date)).toEqual(['14:00', '14:30']);
      expect(await starts(addDays(date, 7))).toEqual([]); // the same weekday a week later
      const [row] = await rows('SELECT recurrence_type, day_of_week, specific_date::text FROM availability');
      expect(row).toEqual({ recurrence_type: 'ONE_TIME', day_of_week: null, specific_date: date });
    });

    it('can be removed again, and only by its own doctor', async () => {
      const date = nextDay();
      const id = (await postOneTime({ date, startTime: '14:00', endTime: '15:00' }).expect(201)).body.oneTime[0].id as string;
      await http().delete(`/api/doctor-portal/availability/one-time/${id}`).set(as(patientTokens[0])).expect(403);
      await http().delete(`/api/doctor-portal/availability/one-time/${id}`).set(as(doctorToken)).expect(200);
      expect(await starts(date)).toEqual([]);
      await http().delete(`/api/doctor-portal/availability/one-time/${id}`).set(as(doctorToken)).expect(404);
    });

    it('does not let the weekly editor touch it', async () => {
      const date = nextDay();
      await postOneTime({ date, startTime: '14:00', endTime: '15:00' }).expect(201);
      await putWeekly([]).expect(200);
      expect(await starts(date)).toEqual(['14:00', '14:30']);
    });
  });

  describe('precedence', () => {
    it('one-time wins over weekly for the time it overlaps, and weekly still applies outside it', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200); // 09:00-12:00, 30-minute STREAM
      await postOneTime({ date, startTime: '10:00', endTime: '11:00', schedulingMode: 'WAVE', capacityPerSlot: 3 }).expect(201);
      const slots = (await day(date)).slots;
      expect(slots.map((slot) => `${slot.startTime}/${slot.mode}/${slot.capacityPerSlot}`)).toEqual([
        '09:00/STREAM/1',
        '09:30/STREAM/1',
        '10:00/WAVE/3',
        '10:30/WAVE/3',
        '11:00/STREAM/1',
        '11:30/STREAM/1',
      ]);
    });

    it('a date exception replaces the whole day, one-time and weekly alike', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      await postOneTime({ date, startTime: '14:00', endTime: '15:00' }).expect(201);
      await putOverride({ date, isAvailable: true, startTime: '16:00', endTime: '17:00', capacity: 5 }).expect(200);
      const view = await day(date);
      expect(view.slots.map((slot) => slot.startTime)).toEqual(['16:00', '16:30']);
      expect(view.sessions.map((session) => session.source)).toEqual(['OVERRIDE']);
    });

    it('a day off removes everything and says why', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      await postOneTime({ date, startTime: '14:00', endTime: '15:00' }).expect(201);
      await putOverride({ date, isAvailable: false, reason: 'Conference' }).expect(200);
      const view = await day(date);
      expect(view.slots).toEqual([]);
      expect(view.unavailableReason).toBe('Conference');
    });

    it('an exception on the day keeps WAVE if the day would have been WAVE', async () => {
      const date = nextDay();
      await postOneTime({ date, startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 2 }).expect(201);
      await putOverride({ date, isAvailable: true, startTime: '13:00', endTime: '14:00', capacity: 5 }).expect(200);
      expect((await day(date)).slots).toMatchObject([
        { startTime: '13:00', mode: 'WAVE', capacityPerSlot: 2 },
        { startTime: '13:30', mode: 'WAVE', capacityPerSlot: 2 },
      ]);
    });
  });

  describe('partial-day override', () => {
    it('blocks only the slots that overlap the blocked time', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      await putOverride({ date, isAvailable: false, startTime: '10:00', endTime: '11:00', reason: 'Surgery' }).expect(200);
      expect(await starts(date)).toEqual(['09:00', '09:30', '11:00', '11:30']);
      // The blocked time cannot be booked, but the rest of the day can.
      await book(0, date, '10:00').expect(400);
      await book(0, date, '11:00').expect(201);
    });

    it('is stored with its times and shown to the doctor', async () => {
      const date = nextDay();
      const saved = await putOverride({ date, isAvailable: false, startTime: '10:00', endTime: '11:00' }).expect(200);
      expect(saved.body.overrides).toMatchObject([{ date, isAvailable: false, startTime: '10:00', endTime: '11:00', capacity: null }]);
    });

    it('needs both times or neither, and the end after the start', async () => {
      const date = nextDay();
      await putOverride({ date, isAvailable: false, startTime: '10:00' }).expect(400);
      await putOverride({ date, isAvailable: false, startTime: '11:00', endTime: '10:00' }).expect(400);
    });
  });

  describe('WAVE slots and capacity', () => {
    const waveDay = async (capacityPerSlot = 2) => {
      const date = nextDay();
      await postOneTime({ date, startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot }).expect(201);
      return date;
    };

    it('generates slots with their capacity and remaining seats', async () => {
      const date = await waveDay(3);
      expect((await day(date)).slots).toMatchObject([
        { startTime: '09:00', endTime: '09:30', status: 'AVAILABLE', capacityPerSlot: 3, booked: 0, remaining: 3, mode: 'WAVE' },
        { startTime: '09:30', endTime: '10:00', status: 'AVAILABLE', capacityPerSlot: 3, booked: 0, remaining: 3, mode: 'WAVE' },
      ]);
    });

    it('takes several patients in one slot, each in its own seat, and records where the slot came from', async () => {
      const date = await waveDay(3);
      const availabilityId = (await rows<{ id: string }>('SELECT id FROM availability'))[0].id;
      await book(0, date, '09:00').expect(201);
      await book(1, date, '09:00', { availabilityId }).expect(201);
      expect(await activeAppointments(date)).toEqual([
        { start_time: '09:00:00', slot_number: 1, slot_capacity: 3, availability_id: availabilityId },
        { start_time: '09:00:00', slot_number: 2, slot_capacity: 3, availability_id: availabilityId },
      ]);
      expect((await day(date)).slots[0]).toMatchObject({ status: 'AVAILABLE', booked: 2, remaining: 1 });
    });

    it('answers 409 when the slot\'s capacity is reached, and hides it from the available slots', async () => {
      const date = await waveDay(2);
      await book(0, date, '09:00').expect(201);
      await book(1, date, '09:00').expect(201);
      const refused = await book(2, date, '09:00').expect(409);
      expect(refused.body.message).toMatch(/slot is full/i);
      expect((await day(date)).slots[0]).toMatchObject({ status: 'BOOKED', remaining: 0 });
      expect(await starts(date, true)).toEqual(['09:30']); // available slots only
      expect(await activeAppointments(date)).toHaveLength(2);
      await book(2, date, '09:30').expect(201); // the other slot is untouched
    });

    it('counts capacity per slot, independently', async () => {
      const date = await waveDay(1 + 1);
      await book(0, date, '09:00').expect(201);
      await book(1, date, '09:00').expect(201);
      await book(2, date, '09:30').expect(201);
      await book(3, date, '09:30').expect(201);
      await book(4, date, '09:30').expect(409);
    });

    it('frees a seat when a patient cancels, and reuses it', async () => {
      const date = await waveDay(2);
      const first = (await book(0, date, '09:00').expect(201)).body;
      await book(1, date, '09:00').expect(201);
      await book(2, date, '09:00').expect(409);
      await http().post(`/api/appointments/${first.id}/cancel`).set(as(patientTokens[0])).send({}).expect(200);
      await book(2, date, '09:00').expect(201);
      expect((await activeAppointments(date)).map((row) => row.slot_number)).toEqual([1, 2]);
    });

    it('refuses to move a patient into a full slot and leaves their appointment alone', async () => {
      const date = await waveDay(1 + 1);
      await book(0, date, '09:00').expect(201);
      await book(1, date, '09:00').expect(201);
      const mine = (await book(2, date, '09:30').expect(201)).body;
      await http().post(`/api/appointments/${mine.id}/reschedule`).set(as(patientTokens[2])).send({ date, startTime: '09:00' }).expect(409);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CONFIRMED' }]);
      // A move into a slot with room works, and takes a seat there.
      await http().post(`/api/appointments/${(await book(3, date, '09:30').expect(201)).body.id}/cancel`).set(as(patientTokens[3])).send({}).expect(200);
      const moved = await http().post(`/api/appointments/${mine.id}/reschedule`).set(as(patientTokens[2])).send({ date, startTime: '09:30' });
      expect(moved.status).toBe(400); // the same slot: not a move
    });

    it('refuses a booking that names the wrong availability, or one that is not the doctor\'s', async () => {
      const date = await waveDay(2);
      await postOneTime({ date: nextDay(), startTime: '09:00', endTime: '10:00' }).expect(201);
      const other = (await rows<{ id: string }>('SELECT id FROM availability WHERE specific_date <> $1', [date]))[0].id;
      await book(0, date, '09:00', { availabilityId: other }).expect(400);
      await book(0, date, '09:00', { availabilityId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      expect(await activeAppointments(date)).toEqual([]);
    });
  });

  describe('STREAM slots', () => {
    it('take exactly one patient: a second booking of the same slot is a 409', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      await book(0, date, '10:00').expect(201);
      const refused = await book(1, date, '10:00').expect(409);
      expect(refused.body.message).toMatch(/just been booked/i);
      expect((await day(date)).slots.find((slot) => slot.startTime === '10:00')).toMatchObject({ status: 'BOOKED', capacityPerSlot: 1, remaining: 0 });
      expect(await activeAppointments(date)).toEqual([expect.objectContaining({ slot_number: 1, slot_capacity: 1 })]);
    });

    it('keep the session capacity cap they always had', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date, { capacity: 1 })]).expect(200);
      await book(0, date, '09:00').expect(201);
      const refused = await book(1, date, '09:30').expect(409);
      expect(refused.body.message).toMatch(/capacity/i);
    });
  });

  describe('validation', () => {
    const date = () => addDays(today, 3);

    it('rejects invalid time ranges', async () => {
      await postOneTime({ date: date(), startTime: '11:00', endTime: '10:00' }).expect(400);
      await postOneTime({ date: date(), startTime: '10:00', endTime: '10:00' }).expect(400);
      await postOneTime({ date: date(), startTime: '10:00', endTime: '10:20' }).expect(400); // shorter than one 30-minute slot
      await postOneTime({ date: date(), startTime: '10:00', endTime: '11:00', slotDurationMinutes: 90 }).expect(400);
      await postOneTime({ date: date(), startTime: '25:00', endTime: '26:00' }).expect(400);
      await putWeekly([{ dayOfWeek: 1, startTime: '11:00', endTime: '10:00' }]).expect(400);
      expect(await rows('SELECT 1 FROM availability')).toEqual([]);
    });

    it('rejects invalid slot length and capacity', async () => {
      await postOneTime({ date: date(), startTime: '09:00', endTime: '10:00', slotDurationMinutes: 0 }).expect(400);
      await postOneTime({ date: date(), startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 0 }).expect(400);
      await postOneTime({ date: date(), startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 2.5 }).expect(400);
    });

    it('enforces capacity 1 for STREAM', async () => {
      const refused = await postOneTime({ date: date(), startTime: '09:00', endTime: '10:00', schedulingMode: 'STREAM', capacityPerSlot: 3 }).expect(400);
      expect(refused.body.message).toMatch(/exactly one patient/i);
      await putWeekly([{ dayOfWeek: 1, startTime: '09:00', endTime: '10:00', capacityPerSlot: 2 }]).expect(400);
    });

    it('rejects invalid recurrence combinations', async () => {
      await postOneTime({ startTime: '09:00', endTime: '10:00' }).expect(400); // ONE_TIME without a date
      await postOneTime({ date: 'not-a-date', startTime: '09:00', endTime: '10:00' }).expect(400);
      await postOneTime({ date: addDays(today, -1), startTime: '09:00', endTime: '10:00' }).expect(400); // the past
      await postOneTime({ date: date(), dayOfWeek: 1, startTime: '09:00', endTime: '10:00' }).expect(400); // ONE_TIME with a weekday
      await putWeekly([{ startTime: '09:00', endTime: '10:00' }]).expect(400); // WEEKLY without a weekday
      await putWeekly([{ dayOfWeek: 1, specificDate: date(), startTime: '09:00', endTime: '10:00' }]).expect(400); // WEEKLY with a date
      await putWeekly([{ dayOfWeek: 7, startTime: '09:00', endTime: '10:00' }]).expect(400);
    });

    it('rejects overlapping sessions of the same kind, but allows them in separate effective periods', async () => {
      const when = date();
      await postOneTime({ date: when, startTime: '09:00', endTime: '10:00' }).expect(201);
      await postOneTime({ date: when, startTime: '09:30', endTime: '10:30' }).expect(400);
      await postOneTime({ date: when, startTime: '10:00', endTime: '11:00' }).expect(201); // back to back is fine
      await putWeekly([
        { dayOfWeek: 1, startTime: '09:00', endTime: '10:00' },
        { dayOfWeek: 1, startTime: '09:30', endTime: '10:30' },
      ]).expect(400);
      await putWeekly([
        { dayOfWeek: 1, startTime: '09:00', endTime: '10:00', effectiveTo: '2030-01-31' },
        { dayOfWeek: 1, startTime: '09:00', endTime: '10:00', effectiveFrom: '2030-02-01' },
      ]).expect(200);
    });

    it('is also guarded by the database, so nothing can write an invalid row around the API', async () => {
      const insert = (sql: [string, string]) => db.query(`INSERT INTO availability (doctor_id, ${sql[0]}) VALUES ($1, ${sql[1]})`, [doctorId]);
      const bad: [string, [string, string]][] = [
        ['WEEKLY without a weekday', ['recurrence_type, start_time, end_time', "'WEEKLY', '09:00', '10:00'"]],
        ['WEEKLY with a date', ['recurrence_type, day_of_week, specific_date, start_time, end_time', "'WEEKLY', 1, '2030-01-01', '09:00', '10:00'"]],
        ['ONE_TIME without a date', ['recurrence_type, start_time, end_time', "'ONE_TIME', '09:00', '10:00'"]],
        ['ONE_TIME with a weekday', ['recurrence_type, day_of_week, specific_date, start_time, end_time', "'ONE_TIME', 1, '2030-01-01', '09:00', '10:00'"]],
        ['end before start', ['day_of_week, start_time, end_time', "1, '10:00', '09:00'"]],
        ['zero capacity per slot', ['day_of_week, start_time, end_time, capacity_per_slot', "1, '09:00', '10:00', 0"]],
        ['zero slot length', ['day_of_week, start_time, end_time, slot_duration_minutes', "1, '09:00', '10:00', 0"]],
        ['STREAM with capacity 3', ['day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot', "1, '09:00', '10:00', 'STREAM', 3"]],
        ['effective range backwards', ['day_of_week, start_time, end_time, effective_from, effective_to', "1, '09:00', '10:00', '2030-02-01', '2030-01-01'"]],
      ];
      for (const [what, args] of bad) await expect(insert(args), what).rejects.toThrow(/violates check constraint/);
      await expect(insert(['day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot', "1, '09:00', '10:00', 'WAVE', 3"])).resolves.toBeDefined();
      expect(await rows('SELECT 1 FROM availability')).toHaveLength(1);
    });

    it('reports an unknown doctor and a bad date when booking', async () => {
      await http().post('/api/appointments').set(as(patientTokens[0])).send({ doctorId: '00000000-0000-4000-8000-000000000000', date: date(), startTime: '09:00' }).expect(404);
      await book(0, '2030-02-30', '09:00').expect(400);
    });
  });

  describe('concurrent bookings', () => {
    it('never put more patients in a WAVE slot than its capacity', async () => {
      const date = nextDay();
      await postOneTime({ date, startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 3 }).expect(201);

      const responses = await Promise.all(Array.from({ length: PATIENTS }, (_, patient) => book(patient, date, '09:00')));
      const created = responses.filter((response) => response.status === 201);
      const refused = responses.filter((response) => response.status === 409);
      expect({ created: created.length, refused: refused.length, other: responses.length - created.length - refused.length }).toEqual({ created: 3, refused: PATIENTS - 3, other: 0 });
      for (const response of refused) expect(response.body.message).toMatch(/full|just been booked/i);

      // The database agrees: three active appointments, one in each seat, no duplicates.
      expect((await activeAppointments(date)).map((row) => row.slot_number)).toEqual([1, 2, 3]);
      expect((await day(date)).slots[0]).toMatchObject({ status: 'BOOKED', booked: 3, remaining: 0 });
    });

    it('never double-book a STREAM slot', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      const responses = await Promise.all(Array.from({ length: PATIENTS }, (_, patient) => book(patient, date, '10:00')));
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(PATIENTS - 1);
      expect(await activeAppointments(date)).toHaveLength(1);
    });

    it('hold under repeated races, across different slots at once', async () => {
      const date = nextDay();
      await postOneTime({ date, startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 2 }).expect(201);
      // 8 patients, two slots of 2 seats each, requests interleaved: exactly 4 get a seat, 2 per slot.
      const responses = await Promise.all(Array.from({ length: PATIENTS }, (_, patient) => book(patient, date, patient % 2 === 0 ? '09:00' : '09:30')));
      expect(responses.filter((response) => response.status === 201)).toHaveLength(4);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(4);
      const perSlot = await rows<{ start_time: string; n: number }>(
        "SELECT start_time::text, count(*)::int AS n FROM appointments WHERE appointment_date = $1 AND status = 'CONFIRMED' GROUP BY start_time ORDER BY start_time",
        [date],
      );
      expect(perSlot).toEqual([
        { start_time: '09:00:00', n: 2 },
        { start_time: '09:30:00', n: 2 },
      ]);
    });

    it('leave no half-made records behind when a booking is refused', async () => {
      const date = nextDay();
      await postOneTime({ date, startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 1 + 1 }).expect(201);
      await Promise.all(Array.from({ length: PATIENTS }, (_, patient) => book(patient, date, '09:00')));
      expect(await rows('SELECT count(*)::int AS n FROM appointments')).toEqual([{ n: 2 }]);
      // One confirmation per appointment that exists (a refused booking queues none), whichever recipient it is for.
      expect(await rows("SELECT count(DISTINCT appointment_id)::int AS n FROM notifications WHERE kind = 'booking-confirmed'")).toEqual([{ n: 2 }]);
    });
  });

  describe('existing appointments and the weekly editor', () => {
    it('keeps an appointment tied to its availability row while that row is unchanged', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      const availabilityId = (await rows<{ id: string }>('SELECT id FROM availability'))[0].id;
      await book(0, date, '09:00').expect(201);
      await putWeekly([weeklyOn(date)]).expect(200); // saved again, nothing changed
      expect((await rows<{ id: string }>('SELECT id FROM availability'))[0].id).toBe(availabilityId);
      expect((await activeAppointments(date))[0].availability_id).toBe(availabilityId);
    });

    it('never deletes an appointment when its availability row is replaced', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      await book(0, date, '09:00').expect(201);
      await putWeekly([weeklyOn(date, { startTime: '08:00', endTime: '13:00' })]).expect(200);
      const [appointment] = await activeAppointments(date);
      expect(appointment).toMatchObject({ start_time: '09:00:00', availability_id: null });
    });

    it('changing the slot length rewrites the rows that follow it, and refuses while appointments exist', async () => {
      const date = nextDay();
      await putWeekly([weeklyOn(date)]).expect(200);
      await http().put('/api/doctor-portal/settings').set(as(doctorToken)).send({ consultationMinutes: 20 }).expect(200);
      expect((await rows('SELECT slot_duration_minutes FROM availability'))[0]).toEqual({ slot_duration_minutes: 20 });
      expect((await starts(date)).slice(0, 3)).toEqual(['09:00', '09:20', '09:40']);
      await book(0, date, '09:00').expect(201);
      await http().put('/api/doctor-portal/settings').set(as(doctorToken)).send({ consultationMinutes: 30 }).expect(409);
      await db.query('UPDATE doctors SET consultation_minutes = 30');
    });
  });
});
