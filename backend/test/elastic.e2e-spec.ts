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
import { ScheduleChangeNotifier } from '../src/scheduling/schedule-change-notifier.service.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.RESEND_API_KEY = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const WINDOW_DAYS = 30; // BOOKING_WINDOW_DAYS default: the furthest date an appointment can exist on
const PATIENTS = 6;
const nextWeekday = (dow: number, from = 1) => {
  for (let offset = from; offset < from + 8; offset++) if (dayOfWeek(addDays(today, offset)) === dow) return addDays(today, offset);
  throw new Error('unreachable');
};
/** How many dates with this weekday fall between `from` and the end of the booking window. */
const countWeekday = (dow: number, from = today) => {
  let count = 0;
  for (let date = from; date <= addDays(today, WINDOW_DAYS); date = addDays(date, 1)) if (dayOfWeek(date) === dow) count++;
  return count;
};

interface SlotView {
  startTime: string;
  endTime: string;
  status: string;
  capacityPerSlot?: number;
  remaining?: number;
  mode?: string;
}
interface Preview {
  kind: string;
  problems: string[];
  suggestedStarts: string[];
  addedSlots: number;
  removedSlots: number;
  affectedDates: number;
  days: { date: string; added: { startTime: string }[]; removed: { startTime: string }[] }[];
  canApply: boolean;
  splitsAtDate: boolean;
  applyFrom: string;
  current: { startTime: string; endTime: string };
  proposed: { startTime: string; endTime: string };
}

describe('Elastic scheduling: expanding availability (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  let otherDoctorToken: string;
  const patientTokens: string[] = [];
  const monday = nextWeekday(1);
  const thursday = nextWeekday(4);

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;

  const addRow = async (r: { dow?: number; date?: string; start?: string; end?: string; mode?: 'STREAM' | 'WAVE'; perSlot?: number; cap?: number | null; from?: string; to?: string; doctor?: string }) =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes, capacity, effective_from, effective_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 30, $9, $10, $11) RETURNING id`,
        [r.doctor ?? doctorId, r.date ? 'ONE_TIME' : 'WEEKLY', r.date ? null : r.dow, r.date ?? null, r.start ?? '10:00', r.end ?? '12:00', r.mode ?? 'STREAM', r.perSlot ?? 1, r.cap ?? null, r.from ?? null, r.to ?? null],
      )
    ).rows[0].id as string;

  const preview = (id: string, body: Record<string, unknown>, token = doctorToken) => http().post(`/api/doctor-portal/availability/${id}/change/preview`).set(as(token)).send(body);
  const apply = (id: string, body: Record<string, unknown>, token = doctorToken) => http().post(`/api/doctor-portal/availability/${id}/change`).set(as(token)).send(body);
  const widen = (id: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}, from = { startTime: '10:00', endTime: '12:00' }) => apply(id, { startTime, endTime, from, ...extra });
  const slots = async (date: string, doctor = doctorId) => (await http().get(`/api/doctors/${doctor}/slots`).query({ date }).expect(200)).body as { slots: SlotView[]; sessions: { capacity: number; booked: number; remaining: number }[] };
  const times = async (date: string) => (await slots(date)).slots.map((slot) => slot.startTime);
  const book = (patient: number, date: string, startTime: string) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime });
  const rowsFor = (id: string) => rows<{ id: string; start_time: string; end_time: string; effective_from: string | null; effective_to: string | null }>('SELECT id, start_time::text, end_time::text, effective_from::text, effective_to::text FROM availability WHERE id = $1', [id]);

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
    const makeDoctor = async (name: string, email: string) =>
      (await db.query(`INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id`, [await user(name, email, 'DOCTOR'), clinicId, specialtyId])).rows[0].id as string;
    doctorId = await makeDoctor('Dr. Elastic', 'elastic@test.local');
    await makeDoctor('Dr. Other', 'other@test.local');
    for (let n = 1; n <= PATIENTS; n++) {
      const id = await user(`Patient ${n}`, `p${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000000${n}`]);
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => ({ reference: 'em_1' }) }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('elastic@test.local');
    otherDoctorToken = await login('other@test.local');
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

  describe('Wave, recurring', () => {
    it('expands the start: only the new slots appear, and the existing booking, its place and its slot are untouched', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const booked = (await book(0, monday, '10:00').expect(201)).body;
      expect(await times(monday)).toEqual(['10:00', '10:30', '11:00', '11:30']);

      const shown = (await preview(id, { startTime: '09:00', endTime: '12:00' }).expect(200)).body as Preview;
      expect(shown).toMatchObject({ kind: 'EXPAND', problems: [], canApply: true, current: { startTime: '10:00', endTime: '12:00' }, proposed: { startTime: '09:00', endTime: '12:00' }, splitsAtDate: true, applyFrom: today, removedSlots: 0 });
      expect(shown.addedSlots).toBe(2 * countWeekday(1));
      expect(shown.affectedDates).toBe(countWeekday(1));
      expect(shown.days[0].added.map((slot) => slot.startTime)).toEqual(['09:00', '09:30']);
      // A preview changes nothing.
      expect(await rowsFor(id)).toMatchObject([{ start_time: '10:00:00', end_time: '12:00:00', effective_to: null }]);

      const done = (await widen(id, '09:00', '12:00').expect(200)).body;
      expect(done).toMatchObject({ kind: 'EXPAND', split: true, addedSlots: shown.addedSlots });
      const day = await slots(monday);
      expect(day.slots.map((slot) => slot.startTime)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
      expect(day.slots.every((slot) => slot.capacityPerSlot === 2 && slot.mode === 'WAVE')).toBe(true); // same length and places per slot
      expect(day.slots.find((slot) => slot.startTime === '10:00')).toMatchObject({ remaining: 1 }); // the existing booking still holds its place
      expect(day.slots.find((slot) => slot.startTime === '09:00')).toMatchObject({ remaining: 2 });
      expect(await rows('SELECT id, status, slot_number, start_time::text FROM appointments')).toEqual([{ id: booked.id, status: 'CONFIRMED', slot_number: 1, start_time: '10:00:00' }]);

      // The new time is bookable, up to its capacity, and not beyond.
      await book(1, monday, '09:00').expect(201);
      await book(2, monday, '09:00').expect(201);
      expect((await book(3, monday, '09:00').expect(409)).body.message).toMatch(/full/i);
    });

    it('expands the end, keeping the start where it was', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      await book(0, monday, '11:30').expect(201);
      await widen(id, '10:00', '13:00').expect(200);
      expect(await times(monday)).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
      expect((await slots(monday)).slots.find((slot) => slot.startTime === '11:30')).toMatchObject({ remaining: 1 });
      await book(1, monday, '12:30').expect(201);
    });

    it('keeps history: the old row ends the day before, earlier appointments keep it, later ones follow the new row', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const past = (await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, availability_id)
         SELECT p.id, $1, p.user_id, $2, '10:00', '10:30', 'COMPLETED', $3 FROM patients p LIMIT 1 RETURNING id`,
        [doctorId, addDays(today, -7), id],
      )).rows[0].id as string;
      const upcoming = (await book(0, monday, '10:00').expect(201)).body;

      const done = (await widen(id, '09:00', '12:00').expect(200)).body as { id: string };
      expect(await rows('SELECT effective_from::text, effective_to::text, start_time::text FROM availability ORDER BY effective_from NULLS FIRST')).toEqual([
        { effective_from: null, effective_to: addDays(today, -1), start_time: '10:00:00' },
        { effective_from: today, effective_to: null, start_time: '09:00:00' },
      ]);
      expect(await rows('SELECT availability_id FROM appointments WHERE id = $1', [past])).toEqual([{ availability_id: id }]); // the past stays as it was
      expect(await rows('SELECT availability_id FROM appointments WHERE id = $1', [upcoming.id])).toEqual([{ availability_id: done.id }]);
      expect((await slots(addDays(today, -7))).slots.filter((slot) => slot.status === 'AVAILABLE')).toEqual([]); // nothing can be booked in the past
    });

    it('applies from a later date: the dates before it keep their hours', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const later = addDays(monday, 7);
      const shown = (await preview(id, { startTime: '09:00', endTime: '12:00', applyFrom: later }).expect(200)).body as Preview;
      expect(shown.addedSlots).toBe(2 * countWeekday(1, later));
      await widen(id, '09:00', '12:00', { applyFrom: later }).expect(200);
      expect(await times(monday)).toEqual(['10:00', '10:30', '11:00', '11:30']); // unchanged
      expect((await times(later))[0]).toBe('09:00');
      expect(await rows('SELECT effective_to::text FROM availability WHERE effective_from IS NULL')).toEqual([{ effective_to: addDays(later, -1) }]);
    });

    it('changes the same session again from today without piling up rows', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const first = (await widen(id, '09:00', '12:00').expect(200)).body as { id: string; split: boolean };
      expect(first.split).toBe(true);
      const second = (await widen(first.id, '08:30', '12:00', {}, { startTime: '09:00', endTime: '12:00' }).expect(200)).body as { id: string; split: boolean };
      expect(second).toMatchObject({ id: first.id, split: false }); // the row already starts today: changed in place
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 2 }]);
      expect((await times(monday))[0]).toBe('08:30');
    });
  });

  describe('Stream, recurring', () => {
    it('expands both ends and keeps the session capacity and one patient per slot', async () => {
      const id = await addRow({ dow: 1, cap: 3 });
      await book(0, monday, '10:00').expect(201);
      await widen(id, '09:00', '13:00').expect(200);
      const day = await slots(monday);
      expect(day.slots.map((slot) => slot.startTime)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
      expect(day.slots.every((slot) => slot.capacityPerSlot === 1 && slot.mode === 'STREAM')).toBe(true);
      expect(day.sessions[0]).toMatchObject({ capacity: 3, booked: 1, remaining: 2 }); // the session cap was not scaled with the hours
      expect((await rows('SELECT capacity FROM availability WHERE effective_to IS NULL'))[0]).toEqual({ capacity: 3 });
      expect((await book(1, monday, '10:00').expect(409)).body.message).toMatch(/just been booked/i); // still one patient per slot
      await book(1, monday, '09:00').expect(201);
      await book(2, monday, '12:00').expect(201);
      expect((await book(3, monday, '12:30').expect(409)).body.message).toMatch(/capacity/i); // the cap of 3 still holds
    });
  });

  describe('non-recurring', () => {
    it('Wave: changes only its own date, in place, and leaves the same weekday elsewhere alone', async () => {
      const date = thursday;
      const id = await addRow({ date, mode: 'WAVE', perSlot: 2 });
      await addRow({ dow: 4, start: '14:00', end: '15:00' }); // a weekly Thursday session
      await book(0, date, '10:00').expect(201);
      const shown = (await preview(id, { startTime: '09:00', endTime: '12:00' }).expect(200)).body as Preview;
      expect(shown).toMatchObject({ kind: 'EXPAND', splitsAtDate: false, affectedDates: 1, addedSlots: 2 });
      const done = (await widen(id, '09:00', '12:00').expect(200)).body as { id: string; split: boolean };
      expect(done).toMatchObject({ id, split: false });
      expect(await times(date)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30']);
      expect(await times(addDays(date, 7))).toEqual(['14:00', '14:30']); // next Thursday: only the weekly session
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 2 }]);
      expect((await slots(date)).slots.find((slot) => slot.startTime === '10:00')).toMatchObject({ remaining: 1 });
    });

    it('Stream: changes only its own date and keeps the cap', async () => {
      const id = await addRow({ date: thursday, cap: 4 });
      await book(0, thursday, '10:30').expect(201);
      await widen(id, '10:00', '13:00').expect(200);
      expect(await times(thursday)).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
      expect((await slots(thursday)).sessions[0]).toMatchObject({ capacity: 4, booked: 1 });
      expect(await times(addDays(thursday, 7))).toEqual([]);
    });

    it('refuses a date that has passed', async () => {
      const id = await addRow({ date: addDays(today, -1) });
      expect((await widen(id, '09:00', '12:00').expect(409)).body.message).toMatch(/already passed/);
    });
  });

  describe('safety', () => {
    it('refuses a start that would shift the slot grid, says which starts work, and changes nothing', async () => {
      const id = await addRow({ dow: 1 });
      const shown = (await preview(id, { startTime: '09:15', endTime: '12:00' }).expect(200)).body as Preview;
      expect(shown).toMatchObject({ canApply: false, suggestedStarts: ['09:00', '09:30'] });
      expect(shown.problems[0]).toMatch(/steps of 30 minutes/);
      expect((await widen(id, '09:15', '12:00').expect(400)).body.message).toMatch(/steps of 30 minutes/);
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 1 }]);
    });

    it('refuses extra time too short for a slot', async () => {
      const id = await addRow({ dow: 1 });
      expect(((await preview(id, { startTime: '10:00', endTime: '12:10' }).expect(200)).body as Preview).problems[0]).toMatch(/shorter than one 30-minute slot/);
      await widen(id, '10:00', '12:10').expect(400);
    });

    it('refuses hours that run into another session, and accepts back-to-back ones', async () => {
      const id = await addRow({ dow: 1 });
      await addRow({ dow: 1, start: '13:00', end: '15:00' });
      expect((await widen(id, '10:00', '14:00').expect(400)).body.message).toMatch(/overlap another session/);
      await widen(id, '10:00', '13:00').expect(200);
      expect(await times(monday)).toContain('12:30');
    });

    it('leaves date exceptions alone: a day off stays off and replacement hours stay as they are', async () => {
      const id = await addRow({ dow: 1 });
      const second = addDays(monday, 7);
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'Conference')", [doctorId, monday]);
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, start_time, end_time, capacity) VALUES ($1, $2, true, '14:00', '16:00', 4)", [doctorId, second]);
      const shown = (await preview(id, { startTime: '09:00', endTime: '12:00' }).expect(200)).body as Preview;
      expect(shown.days.map((day) => day.date)).not.toContain(monday);
      expect(shown.days.map((day) => day.date)).not.toContain(second);
      await widen(id, '09:00', '12:00').expect(200);
      expect(await times(monday)).toEqual([]);
      expect(await times(second)).toEqual(['14:00', '14:30', '15:00', '15:30']);
      expect(await rows('SELECT override_date::text, is_available FROM schedule_overrides ORDER BY override_date')).toEqual([
        { override_date: monday, is_available: false },
        { override_date: second, is_available: true },
      ]);
      expect((await times(addDays(second, 7)))[0]).toBe('09:00'); // dates without an exception got the new hours
    });

    it('refuses a change made against hours that have since changed', async () => {
      const id = await addRow({ dow: 1 });
      expect((await widen(id, '09:00', '12:00', {}, { startTime: '10:30', endTime: '12:00' }).expect(409)).body.message).toMatch(/changed since you previewed/);
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 1 }]);
    });

    it('is for the doctor who owns the session only, with valid input', async () => {
      const id = await addRow({ dow: 1 });
      const body = { startTime: '09:00', endTime: '12:00' };
      await preview(id, body, '').expect(401);
      await preview(id, body, patientTokens[0]).expect(403);
      await preview(id, body, otherDoctorToken).expect(404); // someone else's session looks missing
      await apply(id, { ...body, from: { startTime: '10:00', endTime: '12:00' } }, otherDoctorToken).expect(404);
      await preview('00000000-0000-4000-8000-000000000000', body).expect(404);
      await preview('not-a-uuid', body).expect(400);
      await preview(id, { startTime: '9am', endTime: '12:00' }).expect(400);
      await preview(id, { ...body, extra: true }).expect(400);
      await preview(id, { ...body, applyFrom: addDays(today, -1) }).expect(400);
      await preview(id, { ...body, applyFrom: '2030-02-30' }).expect(400);
      await apply(id, body).expect(400); // the hours previewed against are required
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 1 }]);
    });

    it('never builds duplicate rows or slots when the change is sent twice at once', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const results = await Promise.all([widen(id, '09:00', '12:00'), widen(id, '09:00', '12:00')]);
      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409]); // the second sees the changed hours
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 2 }]); // the ended row and the new one, no more
      const all = await times(monday);
      expect(new Set(all).size).toBe(all.length);
      expect(all).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    });

    it('keeps bookings valid when patients book while the hours are being widened', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const responses = await Promise.all([
        widen(id, '09:00', '12:00'),
        ...[0, 1, 2, 3, 4, 5].map((patient) => book(patient, monday, '10:00')),
      ]);
      expect(responses[0].status).toBe(200);
      const created = responses.slice(1).filter((response) => response.status === 201);
      expect(created).toHaveLength(2); // the slot's two places, no more, whichever side of the change they landed on
      expect(responses.slice(1).filter((response) => response.status === 409)).toHaveLength(4);
      expect(await rows("SELECT slot_number FROM appointments WHERE status = 'CONFIRMED' ORDER BY slot_number")).toEqual([{ slot_number: 1 }, { slot_number: 2 }]);
      expect(await times(monday)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    });
  });

  describe('what the doctor and patients see afterwards', () => {
    it('the editor lists the current session once, the history row stays, and saving the weekly hours does not delete it', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      await widen(id, '09:00', '12:00').expect(200);
      const weekly = (await http().get('/api/doctor-portal/availability').set(as(doctorToken)).expect(200)).body.weekly as { startTime: string; dayOfWeek: number }[];
      expect(weekly).toMatchObject([{ dayOfWeek: 1, startTime: '09:00' }]);
      await http().put('/api/doctor-portal/availability/weekly').set(as(doctorToken)).send({ hours: weekly }).expect(200);
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 2 }]); // the ended row was not touched
      expect(await times(monday)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    });

    it('the public directory shows one set of weekly hours, not the history', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      await widen(id, '09:00', '12:00').expect(200);
      const doctor = (await http().get(`/api/doctors/${doctorId}`).expect(200)).body as { weeklyHours: { dayOfWeek: number; startTime: string }[] };
      expect(doctor.weeklyHours).toMatchObject([{ dayOfWeek: 1, startTime: '09:00' }]);
    });
  });
  describe('shrinking', () => {
    interface Affected {
      id: string;
      date: string;
      startTime: string;
      status: string;
      patient: { name: string };
      alternatives: { date: string; startTime: string; remaining: number }[];
    }
    type ShrinkPreview = Preview & { affectedAppointments: Affected[]; affectedCount: number; withoutAlternatives: number };
    const shrink = (id: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}, from = { startTime: '10:00', endTime: '12:00' }) => apply(id, { startTime, endTime, from, ...extra });
    const outsideList = async (token = doctorToken) => (await http().get('/api/doctor-portal/appointments/outside-hours').set(as(token)).expect(200)).body.appointments as (Affected & { asked: { status: string } | null })[];
    // The doctor's request only records who is affected; the background job asks them. Tests run that job on demand.
    const asks = async () => {
      await app.get(ScheduleChangeNotifier).drain();
      return rows<{ to_address: string; body: string; status: string; subject: string; appointment_id: string }>("SELECT to_address, body, status, subject, appointment_id FROM notifications WHERE kind = 'needs-new-time' AND channel = 'email' ORDER BY created_at");
    };
    const mine = async (patient: number) => (await http().get('/api/appointments/mine').set(as(patientTokens[patient])).expect(200)).body as { id: string; status: string; needsNewTime: boolean }[];
    const activeAt = (date: string) => rows<{ id: string; start_time: string; slot_number: number; status: string }>("SELECT id, start_time::text, slot_number, status FROM appointments WHERE appointment_date = $1 AND status IN ('PENDING','CONFIRMED') ORDER BY start_time, slot_number", [date]);

    it('Wave recurring: lists every affected appointment before saving, changes nothing until confirmed, then keeps them booked', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const inside = (await book(0, monday, '10:00').expect(201)).body;
      const outside = (await book(1, monday, '11:00').expect(201)).body;
      await book(2, monday, '11:00').expect(201);

      const shown = (await preview(id, { startTime: '10:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      expect(shown).toMatchObject({ kind: 'SHRINK', problems: [], canApply: true, affectedCount: 2, withoutAlternatives: 0, addedSlots: 0 });
      expect(shown.removedSlots).toBe(2 * countWeekday(1)); // 11:00 and 11:30 on every Monday
      expect(shown.affectedAppointments.map((appointment) => [appointment.patient.name, appointment.startTime]).sort((a, b) => a[0].localeCompare(b[0]))).toEqual([['Patient 2', '11:00'], ['Patient 3', '11:00']]);
      expect(shown.affectedAppointments.every((appointment) => appointment.alternatives.length > 0 && appointment.alternatives.every((option) => option.remaining > 0))).toBe(true);
      expect(shown.affectedAppointments.map((appointment) => appointment.id)).not.toContain(inside.id); // the 10:00 booking still fits
      // A preview changes nothing: hours, bookings and messages.
      expect(await times(monday)).toEqual(['10:00', '10:30', '11:00', '11:30']);
      expect(await asks()).toEqual([]);

      // Saving needs the doctor's explicit agreement, and nothing happens without it.
      expect((await shrink(id, '10:00', '11:00').expect(409)).body.message).toMatch(/2 booked appointments would fall outside the new hours/);
      expect(await times(monday)).toEqual(['10:00', '10:30', '11:00', '11:30']);

      const done = (await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200)).body;
      expect(done).toMatchObject({ kind: 'SHRINK', split: true, affectedAppointments: 2, patientsAsked: 2 });
      // New bookings in the removed time stop at once...
      expect(await times(monday)).toEqual(['10:00', '10:30']);
      await book(3, monday, '11:00').expect(400);
      // ...but nobody who had booked is moved, changed or cancelled.
      const now = (await activeAt(monday)).map((appointment) => [appointment.id, appointment.start_time, appointment.status]);
      expect(now).toEqual(expect.arrayContaining([[inside.id, '10:00:00', 'CONFIRMED'], [outside.id, '11:00:00', 'CONFIRMED']]));
      expect(now).toHaveLength(3);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CANCELLED'")).toEqual([{ n: 0 }]);

      // Each affected patient was asked, once, and only them.
      const sent = await asks();
      expect(sent.map((message) => message.to_address).sort()).toEqual(['p2@test.local', 'p3@test.local']);
      expect(sent[0].body).toMatch(/Nothing has been cancelled or moved/);
      expect(sent[0].body).toContain(`/doctors/${doctorId}?reschedule=`);
    });

    it('Wave recurring: reducing the start keeps the slot grid, and flags the appointment that is now too early', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      await book(0, monday, '10:00').expect(201);
      await book(1, monday, '10:30').expect(201);
      const shown = (await preview(id, { startTime: '10:30', endTime: '12:00' }).expect(200)).body as ShrinkPreview;
      expect(shown).toMatchObject({ kind: 'SHRINK', canApply: true, affectedCount: 1 });
      expect(shown.affectedAppointments[0]).toMatchObject({ startTime: '10:00', patient: { name: 'Patient 1' } });
      const misaligned = (await preview(id, { startTime: '10:20', endTime: '12:00' }).expect(200)).body as Preview;
      expect(misaligned).toMatchObject({ canApply: false, suggestedStarts: ['10:00', '10:30'] });
      await shrink(id, '10:30', '12:00', { acknowledge: true }).expect(200);
      expect(await times(monday)).toEqual(['10:30', '11:00', '11:30']);
      expect((await slots(monday)).slots[0]).toMatchObject({ startTime: '10:30', remaining: 1 }); // the 10:30 booking is still counted
    });

    it('Stream recurring: keeps the session cap and one patient per slot, and flags what falls outside', async () => {
      const id = await addRow({ dow: 1, cap: 3 });
      await book(0, monday, '10:00').expect(201);
      await book(1, monday, '11:30').expect(201);
      const shown = (await preview(id, { startTime: '10:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      expect(shown).toMatchObject({ canApply: true, affectedCount: 1 });
      expect(shown.affectedAppointments[0]).toMatchObject({ startTime: '11:30', patient: { name: 'Patient 2' } });
      await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200);
      const day = await slots(monday);
      expect(day.slots.map((slot) => slot.startTime)).toEqual(['10:00', '10:30']);
      expect(day.slots.every((slot) => slot.capacityPerSlot === 1)).toBe(true);
      expect((await rows('SELECT capacity FROM availability WHERE effective_to IS NULL'))[0]).toEqual({ capacity: 3 });
      expect((await book(2, monday, '10:00').expect(409)).body.message).toMatch(/just been booked/i);
      await book(2, monday, '10:30').expect(201);
      expect((await activeAt(monday)).length).toBe(3); // the stranded appointment is kept; it never takes a place in the new hours
    });

    it('non-recurring (Wave and Stream): only that date changes, and only its appointments are affected', async () => {
      const wave = await addRow({ date: thursday, mode: 'WAVE', perSlot: 2 });
      await addRow({ dow: 4, start: '14:00', end: '16:00' }); // a weekly Thursday session that must not be touched
      await book(0, thursday, '11:30').expect(201);
      await book(1, addDays(thursday, 7), '14:30').expect(201);
      const shown = (await preview(wave, { startTime: '10:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      expect(shown).toMatchObject({ affectedCount: 1, affectedDates: 1, removedSlots: 2, splitsAtDate: false });
      await shrink(wave, '10:00', '11:00', { acknowledge: true }).expect(200);
      expect(await times(thursday)).toEqual(['10:00', '10:30', '14:00', '14:30', '15:00', '15:30']);
      expect(await times(addDays(thursday, 7))).toEqual(['14:00', '14:30', '15:00', '15:30']); // the weekly session is as it was
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 2 }]);

      const stream = await addRow({ date: addDays(thursday, 14), cap: 2 });
      await book(2, addDays(thursday, 14), '11:00').expect(201);
      const streamShown = (await preview(stream, { startTime: '10:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      expect(streamShown).toMatchObject({ affectedCount: 1, affectedDates: 1 });
    });

    it('with booked and unbooked slots in the removed time, only the booked ones are affected', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 3 });
      await book(0, monday, '11:00').expect(201); // 11:30 stays empty
      const shown = (await preview(id, { startTime: '10:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      expect(shown.removedSlots).toBe(2 * countWeekday(1)); // both removed slots count as removed...
      expect(shown.affectedCount).toBe(1); // ...but only one has anyone in it
    });

    it('when no other time is open, says so, and still saves only on explicit agreement', async () => {
      const id = await addRow({ dow: 1 }); // Stream: every slot takes one patient
      for (const [patient, time] of [[0, '10:00'], [1, '10:30'], [2, '11:00'], [3, '11:30']] as const) await book(patient, monday, time).expect(201);
      // Fill every other Monday in the window, so there is nowhere to go.
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status)
         SELECT p.id, $1, p.user_id, d::date, t.s::time, (t.s::time + interval '30 minutes'), 'CONFIRMED'
         FROM generate_series($2::date, $3::date, interval '1 day') d, (VALUES ('10:00'), ('10:30'), ('11:00'), ('11:30')) AS t(s), (SELECT id, user_id FROM patients ORDER BY id LIMIT 1) p
         WHERE extract(dow FROM d) = 1`,
        [doctorId, addDays(monday, 1), addDays(today, WINDOW_DAYS)],
      );
      // The slots of the first Monday that stay (10:00 and 10:30) are taken too, so the two that leave have no other time.
      const shown = (await preview(id, { startTime: '10:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      const here = shown.affectedAppointments.filter((appointment) => appointment.date === monday);
      expect(here).toHaveLength(2);
      expect(here.every((appointment) => appointment.alternatives.length === 0)).toBe(true);
      expect(shown.withoutAlternatives).toBeGreaterThanOrEqual(2);
      await shrink(id, '10:00', '11:00').expect(409);
      await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200);
      expect((await outsideList()).filter((appointment) => appointment.date === monday).map((appointment) => appointment.alternatives)).toEqual([[], []]);
    });

    it('asks patients to confirm; the appointment moves only when the patient moves it, through the normal reschedule', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const stranded = (await book(0, monday, '11:00').expect(201)).body;
      await book(1, monday, '10:00').expect(201);
      await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200);

      // The patient sees it, and it is still their booking.
      expect(await mine(0)).toMatchObject([{ id: stranded.id, status: 'CONFIRMED', needsNewTime: true }]);
      expect(await mine(1)).toMatchObject([{ needsNewTime: false }]);
      const open = (await outsideList())[0].alternatives[0];
      // Nothing moves until they choose: the patient confirms by rescheduling themselves.
      expect(await rows('SELECT status, start_time::text FROM appointments WHERE id = $1', [stranded.id])).toEqual([{ status: 'CONFIRMED', start_time: '11:00:00' }]);
      const moved = await http().post(`/api/appointments/${stranded.id}/reschedule`).set(as(patientTokens[0])).send({ date: open.date, startTime: open.startTime }).expect(201);
      expect(moved.body).toMatchObject({ status: 'CONFIRMED', date: open.date, startTime: open.startTime });
      expect(await rows('SELECT status, cancel_reason FROM appointments WHERE id = $1', [stranded.id])).toEqual([{ status: 'CANCELLED', cancel_reason: 'Rescheduled by patient' }]);
      expect((await mine(0)).find((appointment) => appointment.status === 'CONFIRMED')).toMatchObject({ needsNewTime: false });
      expect(await outsideList()).toEqual([]);
      // The new slot counts the patient.
      expect((await slots(open.date)).slots.find((slot) => slot.startTime === open.startTime)?.remaining).toBeLessThan(2);
    });

    it('has no doctor-chosen times: the doctor only confirms, every affected patient is told and picks for themselves', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const stranded = (await book(0, monday, '11:00').expect(201)).body;
      const unaffected = (await book(1, monday, '10:00').expect(201)).body;
      // A doctor-picked time is no longer accepted anywhere.
      const choice = (await preview(id, { startTime: '10:00', endTime: '11:00' }).expect(200)).body.affectedAppointments[0].alternatives[0];
      await shrink(id, '10:00', '11:00', { acknowledge: true, proposals: [{ appointmentId: stranded.id, date: choice.date, startTime: choice.startTime }] }).expect(400);
      expect(await asks()).toEqual([]);
      expect(await rows('SELECT status, start_time::text FROM appointments WHERE id = $1', [stranded.id])).toEqual([{ status: 'CONFIRMED', start_time: '11:00:00' }]);

      // Only the hours and the agreement: the affected patient is notified automatically, with no time chosen for them.
      await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200);
      const [message] = await asks();
      expect(message.body).not.toMatch(/The doctor suggests/);
      expect(message.body).not.toMatch(/&date=/);
      expect(message.body).toContain(`reschedule=${stranded.id}`);
      expect(await rows('SELECT proposed_date FROM schedule_change_appointments')).toEqual([{ proposed_date: null }]);
      // Both stay booked until the patient confirms; the unaffected one is untouched.
      expect(await rows("SELECT id, status FROM appointments WHERE id IN ($1, $2) ORDER BY start_time", [unaffected.id, stranded.id])).toEqual([
        { id: unaffected.id, status: 'CONFIRMED' },
        { id: stranded.id, status: 'CONFIRMED' },
      ]);
    });

    it('lists appointments outside the hours, can ask again once a day, and refuses when there is nothing to ask', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const stranded = (await book(0, monday, '11:00').expect(201)).body;
      const inside = (await book(1, monday, '10:00').expect(201)).body;
      await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200);
      const list = await outsideList();
      expect(list.map((appointment) => appointment.id)).toEqual([stranded.id]);
      expect(list[0]).toMatchObject({ asked: null, noticePending: true }); // recorded; the background job has not asked yet
      await app.get(ScheduleChangeNotifier).drain();
      expect((await outsideList())[0]).toMatchObject({ asked: { status: 'PENDING' }, noticePending: false }); // queued; it goes out with the next delivery run
      const ask = (appointmentId: string, token = doctorToken, body: Record<string, unknown> = {}) => http().post(`/api/doctor-portal/appointments/${appointmentId}/ask-new-time`).set(as(token)).send(body);
      expect((await ask(stranded.id).expect(409)).body.message).toMatch(/already asked this patient in the last 24 hours/);
      expect((await ask(inside.id).expect(409)).body.message).toMatch(/within your hours/);
      await ask(stranded.id, otherDoctorToken).expect(404);
      await ask(stranded.id, patientTokens[0]).expect(403);
      await http().get('/api/doctor-portal/appointments/outside-hours').set(as(patientTokens[0])).expect(403);
      expect(await outsideList(otherDoctorToken)).toEqual([]);
    });

    it('treats a day off with bookings the same way: the patient is asked, nobody is cancelled', async () => {
      await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const booked = (await book(0, monday, '10:30').expect(201)).body;
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'Conference')", [doctorId, monday]);
      const list = await outsideList();
      expect(list.map((appointment) => appointment.id)).toEqual([booked.id]);
      expect(list[0].asked).toBeNull();
      await http().post(`/api/doctor-portal/appointments/${booked.id}/ask-new-time`).set(as(doctorToken)).send({}).expect(200);
      expect((await asks()).map((message) => message.to_address)).toEqual(['p1@test.local']);
      expect((await mine(0))[0]).toMatchObject({ status: 'CONFIRMED', needsNewTime: true });
    });

    it('cancellation is the last resort, through the existing doctor cancel, and frees the place', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 1 });
      const stranded = (await book(0, monday, '11:00').expect(201)).body;
      await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CANCELLED'")).toEqual([{ n: 0 }]); // saving cancelled nobody
      await http().post(`/api/doctor-portal/appointments/${stranded.id}/cancel`).set(as(doctorToken)).send({ reason: 'No time suits the patient' }).expect(200);
      expect(await rows('SELECT status, cancel_reason FROM appointments WHERE id = $1', [stranded.id])).toEqual([{ status: 'CANCELLED', cancel_reason: 'No time suits the patient' }]);
      expect(await outsideList()).toEqual([]);
      expect((await mine(0))[0]).toMatchObject({ status: 'CANCELLED', needsNewTime: false });
    });

    it('leaves date exceptions alone: an appointment inside replacement hours is not affected', async () => {
      const id = await addRow({ dow: 1 });
      const second = addDays(monday, 7);
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, start_time, end_time, capacity) VALUES ($1, $2, true, '11:00', '13:00', 4)", [doctorId, second]);
      await book(0, second, '12:00').expect(201); // inside the replacement hours, outside the weekly ones
      await book(1, monday, '11:30').expect(201);
      const shown = (await preview(id, { startTime: '10:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      expect(shown.affectedAppointments.map((appointment) => appointment.date)).toEqual([monday]); // only the weekly day
      await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200);
      expect(await times(second)).toEqual(['11:00', '11:30', '12:00', '12:30']); // the exception still rules its day
      expect((await outsideList()).map((appointment) => appointment.date)).toEqual([monday]);
    });

    it('applies from a later date: earlier appointments and hours are preserved', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      const later = addDays(monday, 7);
      await book(0, monday, '11:00').expect(201); // before the change date
      await book(1, later, '11:00').expect(201); // from the change date on
      const shown = (await preview(id, { startTime: '10:00', endTime: '11:00', applyFrom: later }).expect(200)).body as ShrinkPreview;
      expect(shown.affectedAppointments.map((appointment) => appointment.date)).toEqual([later]);
      await shrink(id, '10:00', '11:00', { acknowledge: true, applyFrom: later }).expect(200);
      expect(await times(monday)).toEqual(['10:00', '10:30', '11:00', '11:30']); // untouched
      expect(await times(later)).toEqual(['10:00', '10:30']);
      expect((await outsideList()).map((appointment) => appointment.date)).toEqual([later]);
    });

    it('can be undone by extending again, which makes the appointments fit once more', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      await book(0, monday, '11:00').expect(201);
      const done = (await shrink(id, '10:00', '11:00', { acknowledge: true }).expect(200)).body as { id: string };
      expect((await outsideList()).length).toBe(1);
      await widen(done.id, '10:00', '12:00', {}, { startTime: '10:00', endTime: '11:00' }).expect(200);
      expect(await outsideList()).toEqual([]);
      expect(await times(monday)).toEqual(['10:00', '10:30', '11:00', '11:30']);
      expect((await slots(monday)).slots.find((slot) => slot.startTime === '11:00')).toMatchObject({ remaining: 1 }); // the booking is back in its slot
    });

    it('both ends at once: extends one side and reduces the other, and only the reduced side affects anyone', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      await book(0, monday, '11:30').expect(201);
      await book(1, monday, '10:00').expect(201);
      const shown = (await preview(id, { startTime: '09:00', endTime: '11:00' }).expect(200)).body as ShrinkPreview;
      expect(shown).toMatchObject({ kind: 'MIXED', canApply: true, affectedCount: 1, addedSlots: 2 * countWeekday(1), removedSlots: 2 * countWeekday(1) });
      expect(shown.affectedAppointments[0]).toMatchObject({ startTime: '11:30' });
      await shrink(id, '09:00', '11:00', { acknowledge: true }).expect(200);
      expect(await times(monday)).toEqual(['09:00', '09:30', '10:00', '10:30']);
    });

    it('never builds duplicate changes or notices when the change is sent twice at once', async () => {
      const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
      await book(0, monday, '11:00').expect(201);
      const results = await Promise.all([shrink(id, '10:00', '11:00', { acknowledge: true }), shrink(id, '10:00', '11:00', { acknowledge: true })]);
      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409]);
      expect(await rows('SELECT count(*)::int AS n FROM availability')).toEqual([{ n: 2 }]);
      expect(await asks()).toHaveLength(1);
    });

    it('stays consistent when patients book while the hours are being reduced: nobody is booked into removed time after the change, and everyone booked before it is asked', async () => {
      for (let round = 0; round < 3; round++) {
        await db.query('DELETE FROM notifications; DELETE FROM appointments; DELETE FROM availability;');
        const id = await addRow({ dow: 1, mode: 'WAVE', perSlot: 2 });
        const responses = await Promise.all([shrink(id, '10:00', '11:00', { acknowledge: true }), ...[0, 1, 2, 3, 4, 5].map((patient) => book(patient, monday, '11:00'))]);
        // The change takes the doctor lock either before the bookings (they are all turned away) or after some of them (they are
        // stranded, never more than the slot's two places, and every one of them is asked).
        expect(responses[0].status).toBe(200);
        const created = responses.slice(1).filter((response) => response.status === 201).length;
        expect(created).toBeLessThanOrEqual(2);
        expect(await activeAt(monday)).toHaveLength(created);
        expect(await times(monday)).toEqual(['10:00', '10:30']);
        await book(5, monday, '11:00').expect(400); // after the change, nobody can book the removed time
        expect((await outsideList()).length).toBe(created);
        expect((await asks()).length).toBe(created); // every appointment that ended up outside the hours was asked, none was missed
      }
    });
  });
});
