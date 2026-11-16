// Doctor-wise queue management (backend foundation).
//  - tokens: the next number in ONE doctor's queue for ONE clinic day, safe under concurrent check-ins, never reused, restarting each day;
//  - the receptionist checks patients in and out (only doctors who assigned them); the doctor calls the next patient and completes the consultation;
//  - the lifecycle is enforced (no double check-in, no checkout before completion, never two patients served at once);
//  - positions (serving token, ahead, behind) come from the live entries; a cancelled appointment leaves the queue without the
//    existing cancel flows knowing about it; the auto-complete job leaves a waiting or served patient's appointment alone;
//  - every route is limited to the right role, and nobody sees another patient's details.
// The real app, database and services run.

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { completeFinishedAppointments } from '../src/appointments/appointment-lifecycle.js';
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
process.env.RESEND_API_KEY = '';
process.env.BREVO_API_KEY = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';
const TIME_ZONE = process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata';
const today = clinicNow(TIME_ZONE).date;
const PATIENTS = 12;

type Status = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

describe('Queue management (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorA: string; // clinic 1
  let doctorB: string; // clinic 1
  let doctorC: string; // clinic 2
  let doctorUserA: string;
  let receptionistUser1: string;
  const tokens: Record<string, string> = {};
  const patientIds: string[] = [];
  const patientUserIds: string[] = [];
  const patientTokens: string[] = [];
  let seq = 0;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;

  const checkIn = (apptId: string, token = tokens.reception1) => http().post(`/api/queue/reception/appointments/${apptId}/check-in`).set(as(token)).send({});
  const checkOut = (entryId: string, token = tokens.reception1) => http().post(`/api/queue/reception/entries/${entryId}/check-out`).set(as(token)).send({});
  const skipDesk = (entryId: string, token = tokens.reception1) => http().post(`/api/queue/reception/entries/${entryId}/skip`).set(as(token)).send({});
  const returnDesk = (entryId: string, token = tokens.reception1) => http().post(`/api/queue/reception/entries/${entryId}/return`).set(as(token)).send({});
  const callNext = (token = tokens.doctorA) => http().post('/api/queue/doctor/call-next').set(as(token)).send({});
  const complete = (entryId: string, token = tokens.doctorA) => http().post(`/api/queue/doctor/entries/${entryId}/complete`).set(as(token)).send({});
  const skipDoctor = (entryId: string, token = tokens.doctorA) => http().post(`/api/queue/doctor/entries/${entryId}/skip`).set(as(token)).send({});
  const doctorQueue = (token = tokens.doctorA, query = '') => http().get(`/api/queue/doctor${query}`).set(as(token));
  const board = (token = tokens.reception1, query = '') => http().get(`/api/queue/reception${query}`).set(as(token));
  const mine = (patient: number) => http().get('/api/queue/mine').set(as(patientTokens[patient]));

  /** An appointment today (or another day) written straight to the database, so the tests do not depend on the time of day. */
  const appt = async (options: { patient: number; doctor?: string; status?: Status; date?: string }) => {
    const n = ++seq;
    const start = `${String(8 + Math.floor(n / 2)).padStart(2, '0')}:${n % 2 ? '30' : '00'}`;
    const status = options.status ?? 'CONFIRMED';
    const cancelled = status === 'CANCELLED';
    return (
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, slot_capacity, slot_number, status, cancelled_at, cancelled_by_user_id, cancel_reason, hold_expires_at)
         VALUES ($1, $2, $3, $4, $5::time, ($5::time + interval '30 minutes'), 1, 1, $6, $7, $8, $9, $10) RETURNING id`,
        [
          patientIds[options.patient],
          options.doctor ?? doctorA,
          patientUserIds[options.patient],
          options.date ?? today,
          start,
          status,
          cancelled ? new Date() : null,
          cancelled ? patientUserIds[options.patient] : null,
          cancelled ? 'test' : null,
          status === 'PENDING' ? new Date(Date.now() + 600_000) : null,
        ],
      )
    ).rows[0].id as string;
  };
  const cancelAppt = (id: string) =>
    db.query("UPDATE appointments SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = $2, cancel_reason = 'test' WHERE id = $1", [id, patientUserIds[0]]);
  const entryOf = async (apptId: string) => (await rows<{ id: string; status: string; token_number: number; called_at: Date | null; completed_at: Date | null; checked_out_at: Date | null }>('SELECT id, status, token_number, called_at, completed_at, checked_out_at FROM queue_entries WHERE appointment_id = $1', [apptId]))[0];
  const apptStatus = async (id: string) => (await rows<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [id]))[0].status;
  /** Checks a patient in and returns the entry id. */
  const arrive = async (apptId: string) => (await checkIn(apptId).expect(200)).body.id as string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);
    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinic1 = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic One', '1 A St') RETURNING id")).rows[0].id as string;
    const clinic2 = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic Two', '2 B St') RETURNING id")).rows[0].id as string;
    const doctor = async (name: string, email: string, clinicId: string) => {
      const userId = await user(name, email, 'DOCTOR');
      const id = (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id', [userId, clinicId, specialtyId])).rows[0].id as string;
      return { id, userId };
    };
    const a = await doctor('Dr. Alpha', 'qa@test.local', clinic1);
    doctorA = a.id;
    doctorUserA = a.userId;
    doctorB = (await doctor('Dr. Beta', 'qb@test.local', clinic1)).id;
    doctorC = (await doctor('Dr. Gamma', 'qc@test.local', clinic2)).id;
    receptionistUser1 = await user('Rita Reception', 'qrec1@test.local', 'RECEPTIONIST');
    const receptionistUser2 = await user('Rob Reception', 'qrec2@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2), ($3, $4)', [receptionistUser1, clinic1, receptionistUser2, clinic2]);
    await db.query(
      'INSERT INTO doctor_receptionist_assignments (doctor_id, receptionist_user_id) VALUES ($1, $2), ($3, $2), ($4, $5)',
      [doctorA, receptionistUser1, doctorB, doctorC, receptionistUser2],
    );
    await user('Ada Admin', 'qadmin@test.local', 'ADMIN');
    for (let n = 1; n <= PATIENTS; n++) {
      const userId = await user(`Patient ${n}`, `qp${n}@test.local`, 'PATIENT');
      patientUserIds.push(userId);
      patientIds.push((await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [userId, `+9190000120${String(n).padStart(2, '0')}`])).rows[0].id as string);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async () => ({ reference: 'em_1' }) })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    tokens.doctorA = await login('qa@test.local');
    tokens.doctorB = await login('qb@test.local');
    tokens.doctorC = await login('qc@test.local');
    tokens.reception1 = await login('qrec1@test.local');
    tokens.reception2 = await login('qrec2@test.local');
    tokens.admin = await login('qadmin@test.local');
    for (let n = 1; n <= PATIENTS; n++) patientTokens.push(await login(`qp${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM queue_events; DELETE FROM queue_entries; DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    seq = 0;
  });

  // After every test: nobody is served twice at once, and no token is repeated within one doctor's day.
  afterEach(async () => {
    expect(await rows("SELECT doctor_id, queue_date FROM queue_entries WHERE status = 'SERVING' GROUP BY 1, 2 HAVING count(*) > 1")).toEqual([]);
    expect(await rows('SELECT doctor_id, queue_date, token_number FROM queue_entries GROUP BY 1, 2, 3 HAVING count(*) > 1')).toEqual([]);
  });

  describe('tokens', () => {
    it('gives the next token in the doctor\'s queue in the order patients arrive, not the order of their appointments', async () => {
      const first = await appt({ patient: 0 }); // earliest appointment
      const second = await appt({ patient: 1 });
      const third = await appt({ patient: 2 });
      const a = (await checkIn(third).expect(200)).body;
      const b = (await checkIn(first).expect(200)).body;
      const c = (await checkIn(second).expect(200)).body;
      expect([a.token, b.token, c.token]).toEqual([1, 2, 3]);
      expect(a).toMatchObject({ appointmentId: third, status: 'WAITING', queueDate: today, doctor: { name: 'Dr. Alpha' }, patient: { name: 'Patient 3' }, ahead: 0, behind: 0, currentlyServingToken: null });
      expect(c).toMatchObject({ ahead: 2, behind: 0 }); // the last to arrive has the two before them ahead
      expect((await doctorQueue().expect(200)).body.waiting.map((entry: { token: number; appointment: { startTime: string } }) => entry.token)).toEqual([1, 2, 3]);
      expect(await rows('SELECT token_number, checked_in_by_user_id FROM queue_entries ORDER BY token_number')).toEqual([
        { token_number: 1, checked_in_by_user_id: receptionistUser1 },
        { token_number: 2, checked_in_by_user_id: receptionistUser1 },
        { token_number: 3, checked_in_by_user_id: receptionistUser1 },
      ]);
    });

    it('keeps a separate queue for each doctor: no hospital-wide sequence', async () => {
      const a1 = await appt({ patient: 0, doctor: doctorA });
      const b1 = await appt({ patient: 1, doctor: doctorB });
      const a2 = await appt({ patient: 2, doctor: doctorA });
      const b2 = await appt({ patient: 3, doctor: doctorB });
      const tokensIssued = [];
      for (const id of [a1, b1, a2, b2]) tokensIssued.push((await checkIn(id).expect(200)).body.token);
      expect(tokensIssued).toEqual([1, 1, 2, 2]);
    });

    it('starts again at 1 each day, per doctor, and leaves an earlier day alone', async () => {
      const yesterday = addDays(today, -1);
      // Yesterday's queue for the same doctor got as far as token 7.
      for (let n = 0; n < 3; n++) {
        const id = await appt({ patient: n, date: yesterday });
        await db.query('INSERT INTO queue_entries (appointment_id, doctor_id, patient_id, queue_date, token_number, status, checked_in_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, doctorA, patientIds[n], yesterday, n + 5, 'WAITING', receptionistUser1]);
      }
      const first = await appt({ patient: 5 });
      const second = await appt({ patient: 6 });
      expect((await checkIn(first).expect(200)).body.token).toBe(1); // today starts again at 1
      expect((await checkIn(second).expect(200)).body.token).toBe(2);
      expect(await rows('SELECT max(token_number)::int AS m FROM queue_entries WHERE queue_date = $1', [yesterday])).toEqual([{ m: 7 }]); // yesterday is untouched
      expect((await doctorQueue().expect(200)).body.waiting.map((entry: { token: number }) => entry.token)).toEqual([1, 2]); // and does not appear in today's queue
    });

    it('never gives a token out twice in one day, even a cancelled one\'s', async () => {
      const first = await appt({ patient: 0 });
      const second = await appt({ patient: 1 });
      const third = await appt({ patient: 2 });
      expect((await checkIn(first).expect(200)).body.token).toBe(1);
      expect((await checkIn(second).expect(200)).body.token).toBe(2);
      await cancelAppt(second);
      expect((await checkIn(third).expect(200)).body.token).toBe(3);
    });

    it('gives ten patients checking in at the same moment ten different tokens, 1 to 10, with no failures', async () => {
      const ids: string[] = [];
      for (let n = 0; n < 10; n++) ids.push(await appt({ patient: n }));
      const results = await Promise.all(ids.map((id) => checkIn(id)));
      expect(results.map((res) => res.status)).toEqual(Array(10).fill(200));
      expect(results.map((res) => res.body.token).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await rows('SELECT 1 FROM queue_entries')).toHaveLength(10);
    });
  });

  describe('check-in', () => {
    it('refuses a second check-in for the same appointment, also when five arrive together: one entry, one token', async () => {
      const id = await appt({ patient: 0 });
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => checkIn(id)));
      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      for (const res of results.filter((entry) => entry.status !== 200)) expect(res.body).toMatchObject({ statusCode: 409, code: 'ALREADY_CHECKED_IN', token: 1 });
      expect(await rows('SELECT 1 FROM queue_entries')).toHaveLength(1);
    });

    it('only for a CONFIRMED appointment on its own day: not unpaid, cancelled, completed, no-show, tomorrow or earlier', async () => {
      const cases: [string, string, Status, string?][] = [
        ['PAYMENT_PENDING', 'waiting for payment', 'PENDING'],
        ['NOT_ELIGIBLE', 'cancelled', 'CANCELLED'],
        ['NOT_ELIGIBLE', 'completed', 'COMPLETED'],
        ['NOT_ELIGIBLE', 'no show', 'NO_SHOW'],
        ['NOT_TODAY', 'not today', 'CONFIRMED', addDays(today, 1)],
        ['NOT_TODAY', 'earlier day', 'CONFIRMED', addDays(today, -1)],
      ];
      for (const [code, words, status, date] of cases) {
        const id = await appt({ patient: 0, status, date });
        const res = await checkIn(id).expect(409);
        expect(res.body.code, words).toBe(code);
        expect(res.body.message, words).toContain(words);
        expect(await entryOf(id), words).toBeUndefined();
      }
    });

    it('only for a clinic the receptionist is assigned to; another clinic\'s or an unknown appointment is "not found"', async () => {
      const mine = await appt({ patient: 0, doctor: doctorA });
      const theirs = await appt({ patient: 1, doctor: doctorC });
      await checkIn(theirs).expect(404);
      await checkIn(mine, tokens.reception2).expect(404);
      await checkIn('11111111-1111-4111-8111-111111111111').expect(404);
      await checkIn('not-a-uuid').expect(400);
      await http().post(`/api/queue/reception/appointments/${mine}/check-in`).set(as(tokens.reception1)).send({ token: 99 }).expect(400); // no body fields
      expect(await rows('SELECT 1 FROM queue_entries')).toEqual([]);
      await checkIn(theirs, tokens.reception2).expect(200); // the right receptionist can
    });

    it('does not change the appointment: it stays confirmed and where it was', async () => {
      const id = await appt({ patient: 0 });
      await checkIn(id).expect(200);
      expect(await apptStatus(id)).toBe('CONFIRMED');
    });
  });

  describe('calling and completing (the doctor)', () => {
    it('calls the lowest token next, one patient at a time', async () => {
      const ids = [await appt({ patient: 0 }), await appt({ patient: 1 }), await appt({ patient: 2 })];
      const second = await arrive(ids[1]);
      await arrive(ids[2]);
      await arrive(ids[0]);
      const called = (await callNext().expect(200)).body;
      expect(called).toMatchObject({ id: second, token: 1, status: 'SERVING', ahead: 0, behind: 2, currentlyServingToken: 1 });
      const again = await callNext().expect(409);
      expect(again.body).toMatchObject({ code: 'CURRENT_NOT_COMPLETED', token: 1 });
      expect(await rows("SELECT token_number FROM queue_entries WHERE status = 'SERVING'")).toEqual([{ token_number: 1 }]);
    });

    it('five doctors\' calls at the same moment serve exactly one patient', async () => {
      for (let n = 0; n < 4; n++) await arrive(await appt({ patient: n }));
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => callNext()));
      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(results.filter((res) => res.status === 409).every((res) => res.body.code === 'CURRENT_NOT_COMPLETED')).toBe(true);
      expect(await rows("SELECT 1 FROM queue_entries WHERE status = 'SERVING'")).toHaveLength(1);
    });

    it('the database itself refuses a second patient being served by the same doctor on the same day', async () => {
      const a = await arrive(await appt({ patient: 0 }));
      const b = await arrive(await appt({ patient: 1 }));
      await db.query("UPDATE queue_entries SET status = 'SERVING', called_at = now() WHERE id = $1", [a]);
      await expect(db.query("UPDATE queue_entries SET status = 'SERVING', called_at = now() WHERE id = $1", [b])).rejects.toThrow(/uq_queue_one_serving/);
    });

    it('completing a consultation completes the appointment, then the next patient can be called', async () => {
      const first = await appt({ patient: 0 });
      const second = await appt({ patient: 1 });
      const e1 = await arrive(first);
      await arrive(second);
      await callNext().expect(200);
      const done = (await complete(e1).expect(200)).body;
      expect(done).toMatchObject({ status: 'COMPLETED', ahead: null, behind: null });
      expect(await apptStatus(first)).toBe('COMPLETED');
      expect(await apptStatus(second)).toBe('CONFIRMED');
      expect((await callNext().expect(200)).body).toMatchObject({ token: 2, status: 'SERVING' });
    });

    it('an empty queue says so', async () => {
      expect((await callNext().expect(409)).body).toMatchObject({ code: 'QUEUE_EMPTY', message: 'No patients are waiting.' });
    });

    it('completing is only possible for the patient being served, once, and only by that doctor', async () => {
      const waiting = await arrive(await appt({ patient: 0 }));
      const served = await arrive(await appt({ patient: 1 }));
      await callNext().expect(200); // token 1 (the first to arrive)
      await complete(waiting, tokens.doctorB).expect(404); // another doctor's patient looks missing
      await complete(served).expect(409); // token 2 is still waiting
      await complete(waiting).expect(200);
      expect((await complete(waiting).expect(409)).body.code).toBe('INVALID_QUEUE_TRANSITION'); // not twice
      await complete('11111111-1111-4111-8111-111111111111').expect(404);
    });

    it('a cancelled appointment leaves the queue without anything being told: calling skips it, and its token is not reused', async () => {
      const ids = [await appt({ patient: 0 }), await appt({ patient: 1 }), await appt({ patient: 2 })];
      for (const id of ids) await arrive(id);
      await cancelAppt(ids[0]); // the first in line cancels through the normal data
      expect((await callNext().expect(200)).body).toMatchObject({ appointmentId: ids[1], token: 2 });
      const queue = (await doctorQueue().expect(200)).body;
      expect(queue.cancelled.map((entry: { token: number }) => entry.token)).toEqual([1]);
      expect(queue.waiting.map((entry: { token: number }) => entry.token)).toEqual([3]);
      expect(queue.counts).toMatchObject({ waiting: 1, serving: 1, cancelled: 1 });
    });

    it('a patient whose appointment is cancelled while being served does not block the queue', async () => {
      const first = await appt({ patient: 0 });
      const second = await appt({ patient: 1 });
      await arrive(first);
      await arrive(second);
      await callNext().expect(200);
      await cancelAppt(first);
      const next = (await callNext().expect(200)).body;
      expect(next).toMatchObject({ appointmentId: second, token: 2, status: 'SERVING' });
      expect(await entryOf(first)).toMatchObject({ status: 'CANCELLED' });
      expect((await rows<{ event: string }>('SELECT event FROM queue_events WHERE entry_id = $1 ORDER BY id', [(await entryOf(first)).id])).map((row) => row.event)).toEqual(['CHECKED_IN', 'CALLED', 'CANCELLED']);
    });

    it('completing a consultation whose appointment was cancelled is refused and the patient is removed', async () => {
      const id = await appt({ patient: 0 });
      const entry = await arrive(id);
      await callNext().expect(200);
      await cancelAppt(id);
      expect((await complete(entry).expect(409)).body.code).toBe('APPOINTMENT_CANCELLED');
      expect(await entryOf(id)).toMatchObject({ status: 'CANCELLED' });
      expect(await apptStatus(id)).toBe('CANCELLED'); // never revived
    });

    it('also works when a patient cancels through the real cancel flow (when the appointment is still ahead of the clock)', async () => {
      const late = clinicNow(TIME_ZONE).time < '23:00';
      const id = await appt({ patient: 0 });
      if (late) await db.query("UPDATE appointments SET start_time = '23:30', end_time = '23:59' WHERE id = $1", [id]);
      await arrive(id);
      if (late) {
        await http().post(`/api/appointments/${id}/cancel`).set(as(patientTokens[0])).send({}).expect(200);
      } else {
        await cancelAppt(id);
      }
      expect((await mine(0).expect(200)).body[0]).toMatchObject({ status: 'CANCELLED', ahead: null, behind: null });
      expect((await callNext().expect(409)).body.code).toBe('QUEUE_EMPTY');
    });
  });

  describe('checkout (the receptionist)', () => {
    it('only after the consultation is completed, once, and the patient is out of the active queue', async () => {
      const id = await appt({ patient: 0 });
      const entry = await arrive(id);
      expect((await checkOut(entry).expect(409)).body.code).toBe('INVALID_QUEUE_TRANSITION'); // waiting
      await callNext().expect(200);
      await checkOut(entry).expect(409); // being served
      await complete(entry).expect(200);
      const out = (await checkOut(entry).expect(200)).body;
      expect(out).toMatchObject({ status: 'CHECKED_OUT', ahead: null, behind: null });
      expect(out.checkedOutAt).toEqual(expect.any(String));
      await checkOut(entry).expect(409); // not twice
      const queue = (await doctorQueue().expect(200)).body;
      expect(queue.serving).toBeNull();
      expect(queue.waiting).toEqual([]);
      expect(queue.checkedOut).toHaveLength(1);
      expect(await rows('SELECT checked_out_by_user_id FROM queue_entries')).toEqual([{ checked_out_by_user_id: receptionistUser1 }]);
    });

    it('only for the receptionist\'s own clinics; a doctor or a patient cannot check out', async () => {
      const entry = await arrive(await appt({ patient: 0 }));
      await callNext().expect(200);
      await complete(entry).expect(200);
      await checkOut(entry, tokens.reception2).expect(404);
      await checkOut(entry, tokens.doctorA).expect(403);
      await checkOut(entry, patientTokens[0]).expect(403);
      await checkOut(entry).expect(200);
    });
  });

  describe('skipping and returning', () => {
    it('a skipped patient is not called, and the appointment is left alone', async () => {
      const a = await appt({ patient: 0 });
      const b = await appt({ patient: 1 });
      const entryA = await arrive(a);
      await arrive(b);
      expect((await skipDesk(entryA).expect(200)).body).toMatchObject({ status: 'SKIPPED', ahead: null });
      expect(await apptStatus(a)).toBe('CONFIRMED');
      expect((await callNext().expect(200)).body).toMatchObject({ appointmentId: b, token: 2 });
    });

    it('the doctor can skip a patient who was called but is not there, and then call the next', async () => {
      const entryA = await arrive(await appt({ patient: 0 }));
      await arrive(await appt({ patient: 1 }));
      await callNext().expect(200);
      await skipDoctor(entryA).expect(200);
      expect((await callNext().expect(200)).body).toMatchObject({ token: 2 });
      await skipDoctor(entryA, tokens.doctorB).expect(404);
    });

    it('only the receptionist returns a skipped patient, who keeps their token and is called in token order again', async () => {
      const entryA = await arrive(await appt({ patient: 0 }));
      await arrive(await appt({ patient: 1 }));
      await arrive(await appt({ patient: 2 }));
      await skipDesk(entryA).expect(200);
      await returnDesk(entryA, tokens.doctorA).expect(403);
      const back = (await returnDesk(entryA).expect(200)).body;
      expect(back).toMatchObject({ status: 'WAITING', token: 1, ahead: 0, behind: 2 });
      expect((await callNext().expect(200)).body).toMatchObject({ id: entryA, token: 1 });
      expect(await rows('SELECT called_by_user_id FROM queue_entries WHERE id = $1', [entryA])).toEqual([{ called_by_user_id: doctorUserA }]);
    });

    it('cannot return a patient who is not skipped, or whose appointment is no longer active', async () => {
      const id = await appt({ patient: 0 });
      const entry = await arrive(id);
      expect((await returnDesk(entry).expect(409)).body.code).toBe('INVALID_QUEUE_TRANSITION');
      await skipDesk(entry).expect(200);
      await cancelAppt(id);
      expect((await returnDesk(entry).expect(409)).body.code).toBe('APPOINTMENT_NOT_ACTIVE');
      await skipDesk(entry).expect(409); // not twice
    });
  });

  describe('positions (from the live queue)', () => {
    it('shows a patient their token, who is being served, and how many are ahead and behind, and it moves as the queue does', async () => {
      const ids = [];
      for (let n = 0; n < 4; n++) ids.push(await appt({ patient: n }));
      const entries = [];
      for (const id of ids) entries.push(await arrive(id));
      expect((await mine(2).expect(200)).body).toEqual([expect.objectContaining({ token: 3, status: 'WAITING', ahead: 2, behind: 1, currentlyServingToken: null, doctor: { id: doctorA, name: 'Dr. Alpha' } })]);

      await callNext().expect(200); // token 1 is served
      expect((await mine(2).expect(200)).body[0]).toMatchObject({ ahead: 2, behind: 1, currentlyServingToken: 1 }); // the patient being served is still ahead
      expect((await mine(0).expect(200)).body[0]).toMatchObject({ status: 'SERVING', ahead: 0, behind: 3 });

      await complete(entries[0]).expect(200);
      expect((await mine(2).expect(200)).body[0]).toMatchObject({ ahead: 1, behind: 1, currentlyServingToken: null });
      await callNext().expect(200); // token 2
      await cancelAppt(ids[1]); // the patient being served leaves
      await skipDesk(entries[2]).expect(200); // token 3 is skipped
      expect((await mine(3).expect(200)).body[0]).toMatchObject({ token: 4, status: 'WAITING', ahead: 0, behind: 0, currentlyServingToken: null }); // the cancelled and the skipped patients are no longer ahead
      expect((await mine(0).expect(200)).body[0]).toMatchObject({ status: 'COMPLETED', ahead: null, behind: null });
    });

    it('a patient who has not been checked in has no queue position', async () => {
      await appt({ patient: 0 });
      expect((await mine(0).expect(200)).body).toEqual([]);
    });

    it('shows a patient only their own entry: other patients appear as counts, never as names or tokens', async () => {
      for (let n = 0; n < 3; n++) await arrive(await appt({ patient: n }));
      const text = JSON.stringify((await mine(1).expect(200)).body);
      expect(text).not.toMatch(/Patient [13]|qp[13]@|\+9190000120/);
      expect(JSON.parse(text)).toHaveLength(1);
      expect((await mine(5).expect(200)).body).toEqual([]);
    });

    it('gives the doctor their own queue in order with positions, and no phone numbers or other private details', async () => {
      for (let n = 0; n < 3; n++) await arrive(await appt({ patient: n }));
      await callNext().expect(200);
      const queue = (await doctorQueue().expect(200)).body;
      expect(queue).toMatchObject({ date: today, doctor: { id: doctorA, name: 'Dr. Alpha' }, currentlyServingToken: 1, counts: { waiting: 2, serving: 1, completed: 0, checkedOut: 0, skipped: 0, cancelled: 0 } });
      expect(queue.serving).toMatchObject({ token: 1, patient: { name: 'Patient 1' }, status: 'SERVING' });
      expect(queue.waiting.map((entry: { token: number; position: number }) => [entry.token, entry.position])).toEqual([[2, 1], [3, 2]]);
      expect(JSON.stringify(queue)).not.toMatch(/phone|@test\.local|\+9190000120/);
      expect((await doctorQueue(tokens.doctorB).expect(200)).body.counts).toMatchObject({ waiting: 0, serving: 0 }); // another doctor sees only their own
    });

    it('gives the front desk each doctor\'s queue at their clinics only', async () => {
      await arrive(await appt({ patient: 0, doctor: doctorA }));
      await checkIn(await appt({ patient: 1, doctor: doctorC }), tokens.reception2).expect(200);
      const desk = (await board().expect(200)).body;
      expect(desk.date).toBe(today);
      expect(desk.doctors.map((entry: { doctor: { name: string } }) => entry.doctor.name)).toEqual(['Dr. Alpha', 'Dr. Beta']);
      expect(desk.doctors[0]).toMatchObject({ counts: { waiting: 1 }, waiting: [{ token: 1, patient: { name: 'Patient 1' } }] });
      expect(JSON.stringify(desk)).not.toMatch(/Dr\. Gamma|Patient 2/);
      expect((await board(tokens.reception1, `?doctorId=${doctorB}`).expect(200)).body.doctors).toHaveLength(1);
      await board(tokens.reception1, `?doctorId=${doctorC}`).expect(404);
      expect((await board(tokens.reception2).expect(200)).body.doctors.map((entry: { doctor: { name: string } }) => entry.doctor.name)).toEqual(['Dr. Gamma']);
    });
  });

  describe('admin board', () => {
    it('shows each doctor\'s counts and serving token for the day, with no patient names', async () => {
      const a1 = await arrive(await appt({ patient: 0, doctor: doctorA }));
      await arrive(await appt({ patient: 1, doctor: doctorA }));
      await checkIn(await appt({ patient: 2, doctor: doctorC }), tokens.reception2).expect(200);
      await callNext().expect(200);
      void a1;
      const result = (await http().get('/api/queue/admin').set(as(tokens.admin)).expect(200)).body;
      expect(result.date).toBe(today);
      expect(result.doctors).toEqual([
        { doctor: { id: doctorA, name: 'Dr. Alpha' }, clinic: 'Clinic One', currentlyServingToken: 1, lastTokenIssued: 2, counts: { waiting: 1, serving: 1, completed: 0, checkedOut: 0, skipped: 0, cancelled: 0 }, status: 'SERVING' },
        { doctor: { id: doctorC, name: 'Dr. Gamma' }, clinic: 'Clinic Two', currentlyServingToken: null, lastTokenIssued: 1, counts: { waiting: 1, serving: 0, completed: 0, checkedOut: 0, skipped: 0, cancelled: 0 }, status: 'WAITING' },
      ]);
      expect(JSON.stringify(result)).not.toMatch(/Patient \d|@test\.local|phone/);
      expect((await http().get(`/api/queue/admin?date=${addDays(today, -3)}`).set(as(tokens.admin)).expect(200)).body.doctors).toEqual([]);
    });
  });

  describe('who may do what', () => {
    it('refuses every route to the wrong roles, and to nobody', async () => {
      const id = await appt({ patient: 0 });
      const entry = await arrive(id);
      const routes: [string, string, string[]][] = [
        ['GET', '/api/queue/reception', ['doctorA', 'admin']],
        ['POST', `/api/queue/reception/appointments/${id}/check-in`, ['doctorA', 'admin']],
        ['POST', `/api/queue/reception/entries/${entry}/check-out`, ['doctorA', 'admin']],
        ['POST', `/api/queue/reception/entries/${entry}/skip`, ['doctorA', 'admin']],
        ['POST', `/api/queue/reception/entries/${entry}/return`, ['doctorA', 'admin']],
        ['GET', '/api/queue/doctor', ['reception1', 'admin']],
        ['POST', '/api/queue/doctor/call-next', ['reception1', 'admin']],
        ['POST', `/api/queue/doctor/entries/${entry}/complete`, ['reception1', 'admin']],
        ['POST', `/api/queue/doctor/entries/${entry}/skip`, ['reception1', 'admin']],
        ['GET', '/api/queue/mine', ['doctorA', 'reception1', 'admin']],
        ['GET', '/api/queue/admin', ['doctorA', 'reception1']],
      ];
      for (const [method, path, denied] of routes) {
        const send = (token?: string) => {
          const req = method === 'GET' ? http().get(path) : http().post(path).send({});
          return token ? req.set(as(token)) : req;
        };
        await send().expect(401);
        for (const who of denied) await send(tokens[who]).expect(403);
        await send(patientTokens[0]).expect(path.endsWith('/mine') ? 200 : 403);
      }
      expect((await entryOf(id)).status).toBe('WAITING'); // none of the refused calls did anything
    });

    it('rejects malformed input', async () => {
      await http().get('/api/queue/doctor?date=nonsense').set(as(tokens.doctorA)).expect(400);
      await http().get('/api/queue/reception?doctorId=nope').set(as(tokens.reception1)).expect(400);
      await http().get('/api/queue/admin?date=2026-02-30').set(as(tokens.admin)).expect(400);
      await http().post('/api/queue/doctor/call-next').set(as(tokens.doctorA)).send({ doctorId: doctorB }).expect(400); // the doctor is the signed-in one, never a parameter
    });
  });

  describe('audit trail', () => {
    it('records every step of a visit, who did it, in order', async () => {
      const entry = await arrive(await appt({ patient: 0 }));
      await callNext().expect(200);
      await complete(entry).expect(200);
      await checkOut(entry).expect(200);
      expect(await rows('SELECT event, from_status, to_status, actor_user_id FROM queue_events WHERE entry_id = $1 ORDER BY id', [entry])).toEqual([
        { event: 'CHECKED_IN', from_status: null, to_status: 'WAITING', actor_user_id: receptionistUser1 },
        { event: 'CALLED', from_status: 'WAITING', to_status: 'SERVING', actor_user_id: doctorUserA },
        { event: 'COMPLETED', from_status: 'SERVING', to_status: 'COMPLETED', actor_user_id: doctorUserA },
        { event: 'CHECKED_OUT', from_status: 'COMPLETED', to_status: 'CHECKED_OUT', actor_user_id: receptionistUser1 },
      ]);
      expect(await rows('SELECT called_by_user_id, completed_by_user_id, checked_out_by_user_id FROM queue_entries WHERE id = $1', [entry])).toEqual([
        { called_by_user_id: doctorUserA, completed_by_user_id: doctorUserA, checked_out_by_user_id: receptionistUser1 },
      ]);
    });

    it('records nothing for a refused action', async () => {
      const entry = await arrive(await appt({ patient: 0 }));
      await checkOut(entry).expect(409);
      await complete(entry).expect(409);
      expect(await rows('SELECT event FROM queue_events')).toEqual([{ event: 'CHECKED_IN' }]);
    });
  });

  describe('the auto-complete job and an un-migrated database', () => {
    const pastEnough = clinicNow(TIME_ZONE).time > '00:40';
    /** A confirmed appointment today that finished long ago by the clock (00:00 to 00:30). */
    const finished = async (patient: number) => {
      const id = await appt({ patient });
      const start = `00:${String(patient * 10).padStart(2, '0')}`; // a different slot for each, so the unique slot index is satisfied
      await db.query("UPDATE appointments SET start_time = $2::time, end_time = ($2::time + interval '5 minutes') WHERE id = $1", [id, start]);
      return id;
    };
    const runJob = () => completeFinishedAppointments(app.get(DataSource), new Date(), TIME_ZONE);

    it.skipIf(!pastEnough)('leaves the appointment of a waiting or served patient alone, and completes it once they have been skipped or seen', async () => {
      const waiting = await finished(0);
      const served = await finished(1);
      const none = await finished(2);
      const e1 = await arrive(waiting);
      await arrive(served);
      await callNext().expect(200); // token 1 (the first to arrive) is served
      await runJob();
      expect(await apptStatus(waiting)).toBe('CONFIRMED');
      expect(await apptStatus(served)).toBe('CONFIRMED');
      expect(await apptStatus(none)).toBe('COMPLETED'); // nobody queued: completed as before
      await skipDoctor(e1).expect(200);
      await runJob();
      expect(await apptStatus(waiting)).toBe('COMPLETED'); // a skipped patient no longer holds it back
      expect(await apptStatus(served)).toBe('CONFIRMED');
    });

    it.skipIf(!pastEnough)('an entry from an earlier day no longer holds an appointment back', async () => {
      const id = await finished(0);
      const entry = await arrive(id);
      await db.query("UPDATE queue_entries SET queue_date = $2 WHERE id = $1", [entry, addDays(today, -1)]);
      await runJob();
      expect(await apptStatus(id)).toBe('COMPLETED');
    });

    it.skipIf(!pastEnough)('still completes finished appointments, and fails plainly for the queue only, when the queue tables do not exist', async () => {
      const id = await finished(0);
      const other = await appt({ patient: 1 });
      await db.query("UPDATE appointments SET start_time = '23:30', end_time = '23:59' WHERE id = $1", [other]); // still ahead of the clock, so the job leaves it confirmed
      await db.query('ALTER TABLE queue_events RENAME TO queue_events_off; ALTER TABLE queue_entries RENAME TO queue_entries_off');
      try {
        await runJob();
        expect(await apptStatus(id)).toBe('COMPLETED');
        const res = await checkIn(other).expect(503);
        expect(res.body.message).toMatch(/not available yet.*migration 015/);
        await doctorQueue().expect(503);
        await mine(0).expect(503);
        // Everything that is not the queue is untouched.
        await http().get('/api/appointments/mine').set(as(patientTokens[0])).expect(200);
        await http().get('/api/doctor-portal/appointments?scope=all').set(as(tokens.doctorA)).expect(200);
      } finally {
        await db.query('ALTER TABLE queue_entries_off RENAME TO queue_entries; ALTER TABLE queue_events_off RENAME TO queue_events');
      }
    });
  });
});
