// Phase A: schedule changes are safe whichever route the doctor uses.
//  - the minimum-notice window refuses a change that would affect an appointment that is too close or under way (whole change, nothing
//    written), in the preview and in the final application, for Adjust hours, date exceptions, removing sessions and the weekly editor;
//  - date exceptions (day off, blocked time, replacement hours, lifting one) and removing sessions go through the same workflow as
//    Adjust hours: appointments stay booked, a tracking row and an email are made for each affected patient, the doctor must agree;
//  - the weekly editor can no longer silently replace a session that has bookings; capacity can rise but not fall below bookings.
//
// The window is set to 72 hours here so "near" (tomorrow) and "far" (five days away) are the same whatever time of day the test runs;
// the exact 1-hour and 2-hour boundaries, including midnight, are covered by change-window.spec.ts.

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
process.env.BREVO_API_KEY = '';
process.env.BACKGROUND_JOBS = 'false';
process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = '72';

const PASSWORD = 'Test@1234';
const clinicTimezone = process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata';
const today = clinicNow(clinicTimezone).date;
const NEAR = addDays(today, 1); // inside the 72-hour window
const NEAR2 = addDays(today, 2); // inside it too, but nobody books it
const FAR = addDays(today, 5); // outside it

describe('Schedule changes are safe, whichever route is used (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctor2Id: string;
  let doctorToken: string;
  let doctor2Token: string;
  const patientTokens: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const notifier = () => app.get(ScheduleChangeNotifier);

  /** A Wave session (30-minute slots) on the weekday of `date`, 09:00-12:00 by default. Returns its id. */
  const addRow = async (date: string, extra: { start?: string; end?: string; perSlot?: number; mode?: 'WAVE' | 'STREAM'; capacity?: number | null; forDoctor?: string } = {}) =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, capacity, slot_duration_minutes)
         VALUES ($1, 'WEEKLY', $2, $3, $4, $5, $6, $7, 30) RETURNING id`,
        [extra.forDoctor ?? doctorId, dayOfWeek(date), extra.start ?? '09:00', extra.end ?? '12:00', extra.mode ?? 'WAVE', extra.mode === 'STREAM' ? 1 : (extra.perSlot ?? 2), extra.capacity ?? null],
      )
    ).rows[0].id as string;
  const book = (patient: number, date: string, startTime: string, forDoctor = doctorId) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId: forDoctor, date, startTime });
  const change = (id: string, startTime: string, endTime: string, from: { startTime: string; endTime: string }, token = doctorToken, extra: Record<string, unknown> = {}) =>
    http().post(`/api/doctor-portal/availability/${id}/change`).set(as(token)).send({ startTime, endTime, from, acknowledge: true, ...extra });
  const preview = (id: string, startTime: string, endTime: string) => http().post(`/api/doctor-portal/availability/${id}/change/preview`).set(as(doctorToken)).send({ startTime, endTime });
  const putOverride = (body: Record<string, unknown>, token = doctorToken) => http().put('/api/doctor-portal/availability/overrides').set(as(token)).send(body);
  const liftOverride = (date: string, acknowledge = false, token = doctorToken) =>
    http().delete(`/api/doctor-portal/availability/overrides/${date}${acknowledge ? '?acknowledge=true' : ''}`).set(as(token));
  const putWeekly = (hours: unknown[], acknowledge?: boolean) => http().put('/api/doctor-portal/availability/weekly').set(as(doctorToken)).send({ hours, ...(acknowledge === undefined ? {} : { acknowledge }) });
  const weekly = (date: string, extra: Record<string, unknown> = {}) => ({ dayOfWeek: dayOfWeek(date), startTime: '09:00', endTime: '12:00', schedulingMode: 'WAVE', capacityPerSlot: 2, slotDurationMinutes: 30, ...extra });
  const tracking = () => rows<{ appointment_id: string; resolution: string | null }>('SELECT appointment_id, resolution FROM schedule_change_appointments ORDER BY created_at');
  const notices = () => rows<{ status: string }>("SELECT status FROM notifications WHERE kind = 'needs-new-time' AND channel = 'email' ORDER BY created_at");
  const status = (id: string) => rows<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [id]).then((r) => r[0].status);
  const count = async (sql: string) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`))[0].n;

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
      (
        await db.query(`INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id`, [
          await user(name, email, 'DOCTOR'),
          clinicId,
          specialtyId,
        ])
      ).rows[0].id as string;
    doctorId = await makeDoctor('Dr. Safe', 'safe@test.local');
    doctor2Id = await makeDoctor('Dr. Second', 'second@test.local');
    for (let n = 1; n <= 4; n++) {
      const id = await user(`Patient ${n}`, `sp${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000100${n}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => ({ reference: 'em_1' }) }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('safe@test.local');
    doctor2Token = await login('second@test.local');
    for (let n = 1; n <= 4; n++) patientTokens.push(await login(`sp${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
  });

  // The invariants that must hold after ANY schedule change, whichever route it took. None of these tests cancels an appointment, so
  // a CANCELLED row would mean a schedule change cancelled someone; and capacity, seats and tracking must stay consistent.
  afterEach(async () => {
    expect(await rows("SELECT id FROM appointments WHERE status = 'CANCELLED'")).toEqual([]); // I5: nothing is ever cancelled by a schedule change
    expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time, slot_number HAVING count(*) > 1")).toEqual([]); // one seat, one person
    expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time HAVING count(*) > max(slot_capacity)")).toEqual([]); // I1
    expect(await rows('SELECT s.appointment_id FROM schedule_change_appointments s LEFT JOIN appointments a ON a.id = s.appointment_id WHERE a.id IS NULL')).toEqual([]); // I7: no orphan tracking
    expect(await rows("SELECT count(*)::int AS n FROM schedule_change_appointments s JOIN appointments a ON a.id = s.appointment_id WHERE s.resolved_at IS NULL AND a.status NOT IN ('PENDING','CONFIRMED')")).toEqual([{ n: 0 }]); // nothing open for an ended appointment
  });

  describe('the minimum-notice window: Adjust hours', () => {
    it('refuses a reduction that affects a near appointment, in the preview and when applied, and writes nothing', async () => {
      const row = await addRow(NEAR);
      const booked = (await book(0, NEAR, '11:30').expect(201)).body;

      const shown = (await preview(row, '09:00', '11:00').expect(200)).body;
      expect(shown.canApply).toBe(false);
      expect(shown.restriction).toMatchObject({ hours: 72, blockedCount: 1, earliest: { id: booked.id, patientName: 'Patient 1', startTime: '11:30' } });
      expect(shown.problems.join(' ')).toMatch(/less than 72 hours away.*Patient 1's appointment.*not allowed within 72 hours/);

      const refused = await change(row, '09:00', '11:00', { startTime: '09:00', endTime: '12:00' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'CHANGE_TOO_CLOSE', restriction: { hours: 72, blockedCount: 1 } });
      expect(refused.body.message).toMatch(/You can make this change after that appointment finishes/);
      expect(await rows('SELECT end_time::text AS e FROM availability')).toEqual([{ e: '12:00:00' }]); // untouched, not split
      expect(await count('SELECT 1 FROM schedule_changes')).toBe(0);
      expect(await status(booked.id)).toBe('CONFIRMED');
    });

    it('allows the same reduction on a day that is outside the window', async () => {
      const row = await addRow(FAR);
      const booked = (await book(0, FAR, '11:30').expect(201)).body;
      expect((await preview(row, '09:00', '11:00').expect(200)).body).toMatchObject({ canApply: true, restriction: null, affectedCount: 1 });
      await change(row, '09:00', '11:00', { startTime: '09:00', endTime: '12:00' }).expect(200);
      expect(await status(booked.id)).toBe('CONFIRMED');
      expect((await tracking()).map((t) => t.appointment_id)).toEqual([booked.id]);
    });

    it('does not block a change that affects nothing close, even when other appointments that day are inside the window', async () => {
      const row = await addRow(NEAR);
      const booked = (await book(0, NEAR, '09:00').expect(201)).body; // inside the window, but still inside the new hours
      const done = await change(row, '09:00', '11:00', { startTime: '09:00', endTime: '12:00' }).expect(200);
      expect(done.body).toMatchObject({ kind: 'SHRINK', affectedAppointments: 0 });
      expect(await status(booked.id)).toBe('CONFIRMED');
    });

    it('does not block a change on a day with no bookings at all', async () => {
      const row = await addRow(NEAR);
      await change(row, '09:00', '11:00', { startTime: '09:00', endTime: '12:00' }).expect(200);
    });

    it('also refuses an expansion that would bring a near, waiting appointment back inside the hours', async () => {
      const row = await addRow(NEAR);
      const booked = (await book(0, NEAR, '11:30').expect(201)).body;
      await db.query("UPDATE availability SET end_time = '11:00' WHERE id = $1", [row]); // left outside the hours earlier
      expect((await preview(row, '09:00', '12:00').expect(200)).body).toMatchObject({ kind: 'EXPAND', restoredCount: 1, canApply: false, restriction: { blockedCount: 1 } });
      const refused = await change(row, '09:00', '12:00', { startTime: '09:00', endTime: '11:00' }).expect(409);
      expect(refused.body.code).toBe('CHANGE_TOO_CLOSE');
      expect(await rows('SELECT end_time::text AS e FROM availability')).toEqual([{ e: '11:00:00' }]);
      expect(await status(booked.id)).toBe('CONFIRMED');
    });

    it('does not block an expansion that restores nobody', async () => {
      const row = await addRow(NEAR, { end: '11:00' });
      await book(0, NEAR, '09:00').expect(201);
      await change(row, '09:00', '12:00', { startTime: '09:00', endTime: '11:00' }).expect(200);
    });

    it('refuses an appointment that has already started (it is no longer "upcoming", but a change must not pull the time out from under it)', async () => {
      const now = clinicNow(clinicTimezone);
      const minutes = Number(now.time.slice(0, 2)) * 60 + Number(now.time.slice(3, 5));
      if (minutes < 15 || minutes > 23 * 60) return; // a started appointment needs a start earlier today; skip in the first and last minutes of the day
      const pad = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
      const row = await addRow(today, { start: '00:00', end: '23:30', perSlot: 2 });
      const patientId = (await rows<{ id: string; user_id: string }>('SELECT id, user_id FROM patients ORDER BY id LIMIT 1'))[0];
      const started = (
        await db.query(
          `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity)
           VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', 1, 2) RETURNING id`,
          [patientId.id, doctorId, patientId.user_id, today, pad(minutes - 10), pad(minutes + 20)],
        )
      ).rows[0].id as string; // a test fixture: the booking engine itself never offers a time that has started
      const refused = await change(row, '00:00', '00:30', { startTime: '00:00', endTime: '23:30' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'CHANGE_TOO_CLOSE' });
      expect(refused.body.message).toContain('which started');
      expect(await status(started)).toBe('CONFIRMED');
      expect(await count('SELECT 1 FROM schedule_changes')).toBe(0);
    });
  });

  describe('date exceptions go through the same workflow', () => {
    it('a day off near an appointment is refused; a day off with no appointments is allowed', async () => {
      await addRow(NEAR);
      await addRow(NEAR2);
      const booked = (await book(0, NEAR, '10:00').expect(201)).body;
      const refused = await putOverride({ date: NEAR, isAvailable: false, reason: 'Away', acknowledge: true }).expect(409);
      expect(refused.body).toMatchObject({ code: 'CHANGE_TOO_CLOSE', restriction: { blockedCount: 1 } });
      expect(await count('SELECT 1 FROM schedule_overrides')).toBe(0);
      expect(await status(booked.id)).toBe('CONFIRMED');
      await putOverride({ date: NEAR2, isAvailable: false, reason: 'Away' }).expect(200); // nobody is affected, so nothing blocks it
      expect(await count('SELECT 1 FROM schedule_overrides')).toBe(1);
    });

    it('a day off far away: refused until the doctor agrees; then the appointment stays booked, is tracked, and the patient is asked', async () => {
      await addRow(FAR);
      const booked = (await book(0, FAR, '10:00').expect(201)).body;
      const asked = await putOverride({ date: FAR, isAvailable: false, reason: 'Away' }).expect(409);
      expect(asked.body).toMatchObject({ code: 'ACKNOWLEDGE_REQUIRED', affectedCount: 1 });
      expect(asked.body.appointments[0]).toMatchObject({ id: booked.id, patient: { name: 'Patient 1' } });
      expect(await count('SELECT 1 FROM schedule_overrides')).toBe(0); // the refusal wrote nothing
      expect(await count('SELECT 1 FROM schedule_changes')).toBe(0);

      const done = (await putOverride({ date: FAR, isAvailable: false, reason: 'Away', acknowledge: true }).expect(200)).body;
      expect(done).toMatchObject({ affectedAppointments: 1, patientsAsked: 1, restoredAppointments: 0 });
      expect(await status(booked.id)).toBe('CONFIRMED'); // never cancelled
      expect(await tracking()).toEqual([{ appointment_id: booked.id, resolution: null }]);
      expect(await rows('SELECT kind, apply_from::text, availability_id, affected_count, new_start_time::text = new_end_time::text AS closed FROM schedule_changes')).toEqual([
        { kind: 'SHRINK', apply_from: FAR, availability_id: null, affected_count: 1, closed: true },
      ]);
      await notifier().drain();
      expect(await notices()).toEqual([{ status: 'PENDING' }]); // the patient will be asked to choose a new time

      // The patient can see it and is offered other times (the day itself is closed).
      const options = (await http().get(`/api/appointments/${booked.id}/alternatives`).set(as(patientTokens[0])).expect(200)).body;
      expect(options.needsNewTime).toBe(true);
      expect(options.alternatives.some((slot: { date: string }) => slot.date === FAR)).toBe(false);
    });

    it('lifting the exception restores the appointment: released without asking, and the queued message is withdrawn', async () => {
      await addRow(FAR);
      const booked = (await book(0, FAR, '10:00').expect(201)).body;
      await putOverride({ date: FAR, isAvailable: false, acknowledge: true }).expect(200);
      await notifier().drain();
      const lifted = (await liftOverride(FAR).expect(200)).body;
      expect(lifted).toMatchObject({ restoredAppointments: 1, affectedAppointments: 0 });
      expect(await tracking()).toEqual([{ appointment_id: booked.id, resolution: 'COVERED' }]);
      expect(await notices()).toEqual([{ status: 'CANCELLED' }]);
      expect(await status(booked.id)).toBe('CONFIRMED');
      expect(await rows("SELECT kind FROM schedule_changes ORDER BY created_at")).toEqual([{ kind: 'SHRINK' }, { kind: 'EXPAND' }]);
    });

    it('lifting an exception that would restore a near appointment is refused too', async () => {
      await addRow(NEAR);
      await book(0, NEAR, '10:00').expect(201);
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'Away')", [doctorId, NEAR]);
      const refused = await liftOverride(NEAR).expect(409);
      expect(refused.body.code).toBe('CHANGE_TOO_CLOSE');
      expect(await count('SELECT 1 FROM schedule_overrides')).toBe(1);
    });

    it('a blocked part of the day affects only the appointments inside it', async () => {
      await addRow(FAR);
      const early = (await book(0, FAR, '09:30').expect(201)).body;
      const late = (await book(1, FAR, '11:30').expect(201)).body;
      const asked = await putOverride({ date: FAR, isAvailable: false, startTime: '11:00', endTime: '12:00' }).expect(409);
      expect(asked.body).toMatchObject({ code: 'ACKNOWLEDGE_REQUIRED', affectedCount: 1 });
      await putOverride({ date: FAR, isAvailable: false, startTime: '11:00', endTime: '12:00', acknowledge: true }).expect(200);
      expect((await tracking()).map((t) => t.appointment_id)).toEqual([late.id]);
      expect(await status(early.id)).toBe('CONFIRMED');
      expect(await status(late.id)).toBe('CONFIRMED');
    });

    it('replacement hours affect only what they leave outside, and extending the day restores it', async () => {
      await addRow(FAR);
      const early = (await book(0, FAR, '09:30').expect(201)).body;
      const late = (await book(1, FAR, '11:30').expect(201)).body;
      await putOverride({ date: FAR, isAvailable: true, startTime: '09:00', endTime: '11:00', capacity: 5 }).expect(409);
      await putOverride({ date: FAR, isAvailable: true, startTime: '09:00', endTime: '11:00', capacity: 5, acknowledge: true }).expect(200);
      expect((await tracking()).map((t) => t.appointment_id)).toEqual([late.id]);
      const wider = (await putOverride({ date: FAR, isAvailable: true, startTime: '09:00', endTime: '13:00', capacity: 5 }).expect(200)).body;
      expect(wider.restoredAppointments).toBe(1);
      expect((await tracking())[0]).toMatchObject({ resolution: 'COVERED' });
      expect(await status(early.id)).toBe('CONFIRMED');
    });

    it('saving the same exception twice is idempotent: one audit row, one tracking row, one notice', async () => {
      await addRow(FAR);
      await book(0, FAR, '10:00').expect(201);
      await putOverride({ date: FAR, isAvailable: false, acknowledge: true }).expect(200);
      const again = (await putOverride({ date: FAR, isAvailable: false, acknowledge: true }).expect(200)).body;
      expect(again).toMatchObject({ affectedAppointments: 0, patientsAsked: 0 });
      await notifier().drain();
      await notifier().drain();
      expect(await count('SELECT 1 FROM schedule_changes')).toBe(1);
      expect(await tracking()).toHaveLength(1);
      expect(await notices()).toHaveLength(1);
    });

    it('replacement hours for a one-patient-per-slot day cannot cap the day below the bookings already made', async () => {
      await addRow(FAR, { mode: 'STREAM', capacity: 4 });
      for (let n = 0; n < 3; n++) await book(n, FAR, ['09:00', '09:30', '10:00'][n]).expect(201);
      const refused = await putOverride({ date: FAR, isAvailable: true, startTime: '09:00', endTime: '12:00', capacity: 2, acknowledge: true }).expect(409);
      expect(refused.body.code).toBe('CAPACITY_BELOW_BOOKINGS');
      expect(refused.body.message).toMatch(/3 booked.*Keep at least 3/);
      expect(await count('SELECT 1 FROM schedule_overrides')).toBe(0);
      await putOverride({ date: FAR, isAvailable: true, startTime: '09:00', endTime: '12:00', capacity: 3, acknowledge: true }).expect(200);
    });

    it('only the doctor can change exceptions', async () => {
      await putOverride({ date: FAR, isAvailable: false }, patientTokens[0]).expect(403);
      await liftOverride(FAR, false, patientTokens[0]).expect(403);
    });
  });

  describe('removing a session', () => {
    it('removing a one-time session near a booking is refused', async () => {
      const id = (await http().post('/api/doctor-portal/availability/one-time').set(as(doctorToken)).send({ date: NEAR, startTime: '09:00', endTime: '10:00' }).expect(201)).body.oneTime[0].id as string;
      await book(0, NEAR, '09:00').expect(201);
      const refused = await http().delete(`/api/doctor-portal/availability/one-time/${id}?acknowledge=true`).set(as(doctorToken)).expect(409);
      expect(refused.body.code).toBe('CHANGE_TOO_CLOSE');
      expect(await count('SELECT 1 FROM availability')).toBe(1);
    });

    it('removing a weekly session with bookings ends it from today, keeps the bookings, and asks the patients (after agreement)', async () => {
      const id = await addRow(FAR);
      const booked = (await book(0, FAR, '11:30').expect(201)).body;
      const asked = await putWeekly([]).expect(409);
      expect(asked.body).toMatchObject({ code: 'ACKNOWLEDGE_REQUIRED', affectedCount: 1 });
      expect(await rows('SELECT effective_to FROM availability')).toEqual([{ effective_to: null }]);

      const done = (await putWeekly([], true).expect(200)).body;
      expect(done.patientsAsked).toBe(1);
      // Ended, not deleted: the history and the booking's link to it survive, and the doctor's list no longer shows it.
      expect(await rows('SELECT id, effective_to::text FROM availability')).toEqual([{ id, effective_to: addDays(today, -1) }]);
      expect(await rows('SELECT availability_id FROM appointments WHERE id = $1', [booked.id])).toEqual([{ availability_id: id }]);
      expect(done.weekly).toEqual([]);
      expect(await status(booked.id)).toBe('CONFIRMED');
      expect(await tracking()).toEqual([{ appointment_id: booked.id, resolution: null }]);
      expect(await rows('SELECT kind, availability_id FROM schedule_changes')).toEqual([{ kind: 'SHRINK', availability_id: id }]);
    });

    it('removing a weekly session near a booking is refused whole', async () => {
      await addRow(NEAR);
      await book(0, NEAR, '10:00').expect(201);
      const refused = await putWeekly([], true).expect(409);
      expect(refused.body.code).toBe('CHANGE_TOO_CLOSE');
      expect(await rows('SELECT effective_to FROM availability')).toEqual([{ effective_to: null }]);
    });

    it('removing a session nobody has booked is still a plain delete', async () => {
      await addRow(FAR);
      await putWeekly([]).expect(200);
      expect(await count('SELECT 1 FROM availability')).toBe(0);
    });
  });

  describe('the weekly editor can no longer bypass the workflow', () => {
    it('changing the hours of a session with bookings is refused with a pointer to Adjust hours, for start, end and both', async () => {
      await addRow(FAR);
      await book(0, FAR, '10:00').expect(201);
      for (const hours of [{ startTime: '09:30' }, { endTime: '11:00' }, { startTime: '10:00', endTime: '13:00' }]) {
        const refused = await putWeekly([weekly(FAR, hours)]).expect(409);
        expect(refused.body.code).toBe('USE_ADJUST_HOURS');
        expect(refused.body.message).toMatch(/Adjust hours/);
      }
      expect(await rows('SELECT start_time::text AS s, end_time::text AS e FROM availability')).toEqual([{ s: '09:00:00', e: '12:00:00' }]);
      expect(await count('SELECT 1 FROM schedule_changes')).toBe(0);
    });

    it('changing the slot length or dates of a session with bookings is refused too', async () => {
      await addRow(FAR);
      await book(0, FAR, '10:00').expect(201);
      expect((await putWeekly([weekly(FAR, { slotDurationMinutes: 20 })]).expect(409)).body.code).toBe('USE_ADJUST_HOURS');
      expect((await putWeekly([weekly(FAR, { effectiveTo: addDays(FAR, 14) })]).expect(409)).body.code).toBe('USE_ADJUST_HOURS');
    });

    it('raising places per slot works in place: same row, booking still linked, nobody asked', async () => {
      const id = await addRow(FAR);
      const booked = (await book(0, FAR, '10:00').expect(201)).body;
      await putWeekly([weekly(FAR, { capacityPerSlot: 4 })]).expect(200);
      expect(await rows('SELECT id, capacity_per_slot FROM availability')).toEqual([{ id, capacity_per_slot: 4 }]);
      expect(await rows('SELECT availability_id FROM appointments WHERE id = $1', [booked.id])).toEqual([{ availability_id: id }]);
      expect(await count('SELECT 1 FROM schedule_changes')).toBe(0);
      // And the new places are really bookable.
      await book(1, FAR, '10:00').expect(201);
      await book(2, FAR, '10:00').expect(201);
      await book(3, FAR, '10:00').expect(201);
    });

    it('lowering places per slot below the bookings already made is refused; down to exactly the bookings is allowed', async () => {
      const id = await addRow(FAR, { perSlot: 3 });
      await book(0, FAR, '10:00').expect(201);
      await book(1, FAR, '10:00').expect(201);
      await book(2, FAR, '10:00').expect(201);
      const refused = await putWeekly([weekly(FAR, { capacityPerSlot: 2 })]).expect(409);
      expect(refused.body).toMatchObject({ code: 'CAPACITY_BELOW_BOOKINGS' });
      expect(refused.body.message).toMatch(/already has 3 booked.*Keep at least 3/);
      expect(await rows('SELECT capacity_per_slot FROM availability WHERE id = $1', [id])).toEqual([{ capacity_per_slot: 3 }]);
      await putWeekly([weekly(FAR, { capacityPerSlot: 3 })]).expect(200);
    });

    it('turning a Wave session into one-patient-per-slot is a capacity reduction and is refused while a slot has two booked', async () => {
      await addRow(FAR, { perSlot: 2 });
      await book(0, FAR, '10:00').expect(201);
      await book(1, FAR, '10:00').expect(201);
      const refused = await putWeekly([weekly(FAR, { schedulingMode: 'STREAM', capacityPerSlot: 1, capacity: 10 })]).expect(409);
      expect(refused.body.code).toBe('CAPACITY_BELOW_BOOKINGS');
    });

    it('a session nobody has booked can be edited freely, as before', async () => {
      await addRow(FAR);
      await putWeekly([weekly(FAR, { startTime: '08:00', endTime: '13:00', capacityPerSlot: 1 })]).expect(200);
      expect(await rows('SELECT start_time::text AS s, end_time::text AS e, capacity_per_slot AS c FROM availability')).toEqual([{ s: '08:00:00', e: '13:00:00', c: 1 }]);
    });

    it('other days are unaffected by a refusal elsewhere: saving the same schedule again is accepted', async () => {
      await addRow(FAR);
      await book(0, FAR, '10:00').expect(201);
      await putWeekly([weekly(FAR)]).expect(200);
    });
  });

  describe('adding hours goes through the same guard (Phase B)', () => {
    const addSession = (body: Record<string, unknown>) => http().post('/api/doctor-portal/availability/one-time').set(as(doctorToken)).send(body);
    /** A day with a session ending at 11:00 and an appointment at 11:30 that was left outside the hours earlier. */
    const stranded = async (date: string) => {
      const row = await addRow(date);
      const booked = (await book(0, date, '11:30').expect(201)).body;
      await db.query("UPDATE availability SET end_time = '11:00' WHERE id = $1", [row]);
      return { row, booked };
    };

    it('a one-time session that would bring a near appointment back inside the hours is refused whole', async () => {
      const { booked } = await stranded(NEAR);
      const refused = await addSession({ date: NEAR, startTime: '11:00', endTime: '12:00' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'CHANGE_TOO_CLOSE', restriction: { blockedCount: 1 } });
      expect(await count('SELECT 1 FROM availability')).toBe(1); // nothing was added
      expect(await status(booked.id)).toBe('CONFIRMED');
    });

    it('a one-time session on a day with nothing near is added, even when it adds new bookable time next to a near appointment', async () => {
      await addRow(NEAR);
      await book(0, NEAR, '09:00').expect(201);
      await addSession({ date: NEAR, startTime: '13:00', endTime: '14:00' }).expect(201); // restores nobody, so nothing blocks it
    });

    it('a far one-time session releases the waiting appointment, and the release is on record as an extension', async () => {
      const row = await addRow(FAR);
      const booked = (await book(0, FAR, '11:30').expect(201)).body;
      await change(row, '09:00', '11:00', { startTime: '09:00', endTime: '12:00' }).expect(200); // strands it, with a tracking row
      const current = (await rows<{ id: string }>('SELECT id FROM availability WHERE effective_to IS NULL'))[0].id;
      expect(current).toBeTruthy();
      const added = (await addSession({ date: FAR, startTime: '11:00', endTime: '12:00' }).expect(201)).body;
      expect(added.restoredAppointments).toBe(1);
      expect(await tracking()).toEqual([{ appointment_id: booked.id, resolution: 'COVERED' }]);
      const newRow = (await rows<{ id: string }>("SELECT id FROM availability WHERE recurrence_type = 'ONE_TIME'"))[0].id;
      expect(await rows('SELECT kind, availability_id, apply_from::text FROM schedule_changes ORDER BY created_at')).toEqual([
        { kind: 'SHRINK', availability_id: expect.any(String), apply_from: today },
        { kind: 'EXPAND', availability_id: newRow, apply_from: FAR },
      ]);
      const history = (await http().get('/api/doctor-portal/schedule-changes').set(as(doctorToken)).expect(200)).body.changes as { kind: string; restored: number }[];
      expect(history.find((entry) => entry.kind === 'EXPAND')).toMatchObject({ restored: 1 });
    });

    it('a weekly session added near a waiting appointment is refused whole; far away it is accepted and releases it', async () => {
      const near = await stranded(NEAR);
      const refused = await putWeekly([weekly(NEAR, { endTime: '11:00' }), weekly(NEAR, { startTime: '11:00', endTime: '12:00' })]).expect(409);
      expect(refused.body.code).toBe('CHANGE_TOO_CLOSE');
      expect(await count('SELECT 1 FROM availability')).toBe(1);
      expect(await status(near.booked.id)).toBe('CONFIRMED');

      // Far away: strand a patient properly (Adjust hours, so there is a tracking row), then add a weekly session that covers them.
      const farRow = await addRow(FAR);
      const farBooked = (await book(1, FAR, '11:30').expect(201)).body;
      await change(farRow, '09:00', '11:00', { startTime: '09:00', endTime: '12:00' }).expect(200);
      const nowRows = (await http().get('/api/doctor-portal/availability').set(as(doctorToken)).expect(200)).body.weekly as Record<string, unknown>[];
      const done = (await putWeekly([...nowRows, weekly(FAR, { startTime: '11:00', endTime: '12:00' })]).expect(200)).body;
      expect(done.restoredAppointments).toBe(1);
      expect(await tracking()).toContainEqual({ appointment_id: farBooked.id, resolution: 'COVERED' });
      expect(await rows('SELECT kind FROM schedule_changes ORDER BY created_at')).toEqual([{ kind: 'SHRINK' }, { kind: 'EXPAND' }]);
      expect(await status(farBooked.id)).toBe('CONFIRMED');
    });

    it('changing the slot interval takes the doctor lock, like every other change to the schedule', async () => {
      await addRow(FAR);
      const holder = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM doctors WHERE id = $1 FOR UPDATE', [doctorId]); // a booking (or any change) is in progress
        let finished = false;
        const pending = http()
          .put('/api/doctor-portal/settings')
          .set(as(doctorToken))
          .send({ slotIntervalMinutes: 15 })
          .then((response) => {
            finished = true;
            return response;
          });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(finished).toBe(false); // waits for the booking in progress instead of racing it
        await holder.query('COMMIT');
        expect((await pending).status).toBe(200);
        expect(await rows('SELECT slot_interval_minutes AS m FROM doctors WHERE id = $1', [doctorId])).toEqual([{ m: 15 }]);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
        await db.query('UPDATE doctors SET slot_interval_minutes = NULL WHERE id = $1', [doctorId]);
      }
    });

    it('adding the same one-time session twice is refused the second time and changes nothing more', async () => {
      await addRow(FAR);
      await addSession({ date: FAR, startTime: '13:00', endTime: '14:00' }).expect(201);
      await addSession({ date: FAR, startTime: '13:00', endTime: '14:00' }).expect(400);
      expect(await count("SELECT 1 FROM availability WHERE recurrence_type = 'ONE_TIME'")).toBe(1);
    });
  });

  describe('two doctors changing schedules at once', () => {
    it('both changes succeed, each affecting only its own patients, with no deadlock', async () => {
      const row1 = await addRow(FAR);
      const row2 = await addRow(FAR, { forDoctor: doctor2Id });
      const a = (await book(0, FAR, '11:30').expect(201)).body;
      const b = (await book(1, FAR, '11:30', doctor2Id).expect(201)).body;
      const [one, two] = await Promise.all([
        change(row1, '09:00', '11:00', { startTime: '09:00', endTime: '12:00' }),
        putOverride({ date: FAR, isAvailable: false, acknowledge: true }, doctor2Token),
      ]);
      expect([one.status, two.status]).toEqual([200, 200]);
      expect(row2).toBeTruthy();
      const byDoctor = await rows<{ doctor_id: string; appointment_id: string }>(
        'SELECT c.doctor_id, s.appointment_id FROM schedule_change_appointments s JOIN schedule_changes c ON c.id = s.change_id ORDER BY c.doctor_id',
      );
      expect(byDoctor).toHaveLength(2);
      expect(byDoctor.find((r) => r.doctor_id === doctorId)?.appointment_id).toBe(a.id);
      expect(byDoctor.find((r) => r.doctor_id === doctor2Id)?.appointment_id).toBe(b.id);
      expect([await status(a.id), await status(b.id)]).toEqual(['CONFIRMED', 'CONFIRMED']);
    });

    it('the same change sent twice at once applies once', async () => {
      await addRow(FAR);
      await book(0, FAR, '10:00').expect(201);
      const [x, y] = await Promise.all([putOverride({ date: FAR, isAvailable: false, acknowledge: true }), putOverride({ date: FAR, isAvailable: false, acknowledge: true })]);
      expect([x.status, y.status]).toEqual([200, 200]);
      expect(await count('SELECT 1 FROM schedule_changes')).toBe(1);
      expect(await tracking()).toHaveLength(1);
    });
  });
});

describe('Schedule changes with the notice window switched off (SCHEDULE_CHANGE_MIN_NOTICE_HOURS=0) (e2e)', () => {
  // A fresh app: the setting is read when the application starts.
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorToken: string;
  let patientToken: string;
  let doctorId: string;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const previous = process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS;

  beforeAll(async () => {
    process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = '0';
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DELETE FROM notifications; DELETE FROM schedule_changes; DELETE FROM appointments; DELETE FROM schedule_overrides; DELETE FROM availability;');
    doctorId = (await db.query("SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.email = 'safe@test.local'")).rows[0].id as string;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => ({ reference: 'em_1' }) }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
    doctorToken = await login('safe@test.local');
    patientToken = await login('sp1@test.local');
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS;
    else process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = previous;
    await app?.close();
    await db?.end();
  });

  it('0 disables the rule: a change affecting tomorrow\'s appointment is allowed (it is still previewed, acknowledged and tracked)', async () => {
    const row = (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
         VALUES ($1, 'WEEKLY', $2, '09:00', '12:00', 'WAVE', 2, 30) RETURNING id`,
        [doctorId, dayOfWeek(NEAR)],
      )
    ).rows[0].id as string;
    const booked = (await http().post('/api/appointments').set(as(patientToken)).send({ doctorId, date: NEAR, startTime: '11:30' }).expect(201)).body;
    const shown = (await http().post(`/api/doctor-portal/availability/${row}/change/preview`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '11:00' }).expect(200)).body;
    expect(shown).toMatchObject({ canApply: true, restriction: null, affectedCount: 1 });
    await http().post(`/api/doctor-portal/availability/${row}/change`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '11:00', from: { startTime: '09:00', endTime: '12:00' }, acknowledge: true }).expect(200);
    expect((await db.query('SELECT status FROM appointments WHERE id = $1', [booked.id])).rows).toEqual([{ status: 'CONFIRMED' }]);
  });
});
