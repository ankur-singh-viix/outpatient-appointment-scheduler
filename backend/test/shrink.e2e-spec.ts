// Production-readiness checks for SHRINKING an availability row after patients have booked it: the audit trail, the background
// notifier (batches, no duplicates, partial failure), the repeated-change rules, alternatives for the patient, resolution tracking,
// pagination, volume, and concurrency. Expanding is covered by elastic.e2e-spec.ts.

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
import { addDays, clinicNow, dayOfWeek } from '../src/scheduling/calendar.js';
import { NOTIFY_BATCH, ScheduleChangeNotifier } from '../src/scheduling/schedule-change-notifier.service.js';

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
const PATIENTS = 6;
const nextWeekday = (dow: number, from = 1) => {
  for (let offset = from; offset < from + 8; offset++) if (dayOfWeek(addDays(today, offset)) === dow) return addDays(today, offset);
  throw new Error('unreachable');
};

interface Outside {
  id: string;
  date: string;
  startTime: string;
  alternatives: { date: string; startTime: string }[];
  asked: { status: string } | null;
  noticePending: boolean;
}

describe('Shrinking hours, production readiness (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  const patientTokens: string[] = [];
  const monday = nextWeekday(1);

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const notifier = () => app.get(ScheduleChangeNotifier);

  const addRow = async (r: { dow?: number; start?: string; end?: string; mode?: 'STREAM' | 'WAVE'; perSlot?: number }) =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
         VALUES ($1, 'WEEKLY', $2, $3, $4, $5, $6, 30) RETURNING id`,
        [doctorId, r.dow ?? 1, r.start ?? '10:00', r.end ?? '12:00', r.mode ?? 'WAVE', r.perSlot ?? 1],
      )
    ).rows[0].id as string;
  const apply = (id: string, startTime: string, endTime: string, from = { startTime: '10:00', endTime: '12:00' }, extra: Record<string, unknown> = {}) =>
    http().post(`/api/doctor-portal/availability/${id}/change`).set(as(doctorToken)).send({ startTime, endTime, from, acknowledge: true, ...extra });
  const preview = (id: string, startTime: string, endTime: string) => http().post(`/api/doctor-portal/availability/${id}/change/preview`).set(as(doctorToken)).send({ startTime, endTime });
  const book = (patient: number, date: string, startTime: string) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime });
  const reschedule = (patient: number, id: string, date: string, startTime: string) => http().post(`/api/appointments/${id}/reschedule`).set(as(patientTokens[patient])).send({ date, startTime });
  const alternatives = (patient: number, id: string) => http().get(`/api/appointments/${id}/alternatives`).set(as(patientTokens[patient]));
  const outside = async (query = '') => (await http().get(`/api/doctor-portal/appointments/outside-hours${query}`).set(as(doctorToken)).expect(200)).body as { appointments: Outside[]; nextCursor: string | null };
  const notices = () => rows<{ appointment_id: string; status: string }>("SELECT appointment_id, status FROM notifications WHERE kind = 'needs-new-time' AND channel = 'email'");
  const tracking = () => rows<{ appointment_id: string; notified_at: Date | null; resolution: string | null; attempts: number }>('SELECT appointment_id, notified_at, resolution, attempts FROM schedule_change_appointments');

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
        await user('Dr. Shrink', 'shrink@test.local', 'DOCTOR'),
        clinicId,
        specialtyId,
      ])
    ).rows[0].id as string;
    for (let n = 1; n <= PATIENTS; n++) {
      const id = await user(`Patient ${n}`, `p${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000000${n}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => ({ reference: 'em_1' }) }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('shrink@test.local');
    for (let n = 1; n <= PATIENTS; n++) patientTokens.push(await login(`p${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
  });

  describe('the change itself', () => {
    it('records an audit row and one tracking row per affected appointment, and sends nothing while the request runs', async () => {
      const id = await addRow({});
      const a = (await book(0, monday, '11:00').expect(201)).body;
      const b = (await book(1, monday, '11:30').expect(201)).body;
      await book(2, monday, '10:00').expect(201); // inside the new hours
      const done = (await apply(id, '10:00', '11:00').expect(200)).body;

      expect(await rows('SELECT kind, apply_from::text, old_start_time::text, old_end_time::text, new_start_time::text, new_end_time::text, affected_count FROM schedule_changes')).toEqual([
        { kind: 'SHRINK', apply_from: today, old_start_time: '10:00:00', old_end_time: '12:00:00', new_start_time: '10:00:00', new_end_time: '11:00:00', affected_count: 2 },
      ]);
      expect((await tracking()).map((row) => row.appointment_id).sort((x, y) => x.localeCompare(y))).toEqual([a.id, b.id].sort((x, y) => x.localeCompare(y)));
      expect(await notices()).toEqual([]); // nothing queued, let alone sent, by the request
      expect(done.affectedAppointments).toBe(2);
      // They are all still booked, with their own times.
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CONFIRMED'")).toEqual([{ n: 3 }]);
    });

    it('asks each affected patient exactly once, however many times the background job runs, even at the same moment', async () => {
      const id = await addRow({});
      for (let n = 0; n < 3; n++) await book(n, monday, ['11:00', '11:30', '10:30'][n]).expect(201);
      await apply(id, '10:00', '11:00').expect(200);
      await Promise.all([notifier().drain(), notifier().drain(), notifier().runBatch()]);
      await notifier().drain();
      const sent = await notices();
      expect(sent).toHaveLength(2); // the 10:30 appointment is inside the new hours
      expect(new Set(sent.map((row) => row.appointment_id)).size).toBe(2);
      expect((await tracking()).filter((row) => row.notified_at !== null)).toHaveLength(2);
    });

    it('does not ask again within 24 hours when the same appointment is affected by a second change', async () => {
      const id = await addRow({});
      await book(0, monday, '11:30').expect(201);
      await apply(id, '10:00', '11:00').expect(200);
      await notifier().drain();
      expect(await notices()).toHaveLength(1);

      // The doctor widens the hours again (an expansion), then reduces them once more while the patient has not answered.
      const rowsNow = await rows<{ id: string }>('SELECT id FROM availability WHERE effective_to IS NULL');
      await apply(rowsNow[0].id, '10:00', '12:00', { startTime: '10:00', endTime: '11:00' }).expect(200);
      await apply((await rows<{ id: string }>('SELECT id FROM availability WHERE effective_to IS NULL'))[0].id, '10:00', '11:00').expect(200);
      await notifier().drain();

      expect(await notices()).toHaveLength(1); // no second email
      expect(await rows('SELECT count(*)::int AS n FROM schedule_changes WHERE kind = \'SHRINK\'')).toEqual([{ n: 2 }]); // but both changes are on record
      expect((await outside()).appointments).toHaveLength(1);
    });

    it('closes the open row as COVERED, without asking, when the hours are widened again before the patient is asked', async () => {
      const id = await addRow({});
      await book(0, monday, '11:30').expect(201);
      await apply(id, '10:00', '11:00').expect(200);
      const now = (await rows<{ id: string }>('SELECT id FROM availability WHERE effective_to IS NULL'))[0].id;
      await apply(now, '10:00', '12:00', { startTime: '10:00', endTime: '11:00' }).expect(200);
      await notifier().drain();
      expect(await notices()).toEqual([]);
      expect((await tracking())[0].resolution).toBe('COVERED');
      expect((await outside()).appointments).toEqual([]);
    });

    it('keeps going when one patient cannot be queued: the others are asked, the failed one is counted and retried', async () => {
      const id = await addRow({});
      const first = (await book(0, monday, '11:00').expect(201)).body;
      await book(1, monday, '11:30').expect(201);
      await apply(id, '10:00', '11:00').expect(200);

      const real = app.get(NotificationsService).queueNewTimeRequest.bind(app.get(NotificationsService));
      const spy = vi.spyOn(app.get(NotificationsService), 'queueNewTimeRequest').mockImplementation(async (manager, appointmentId, input) => {
        if (appointmentId === first.id) throw new Error('mail queue unavailable');
        return real(manager, appointmentId, input);
      });
      await notifier().runBatch();
      expect(await notices()).toHaveLength(1);
      const state = await tracking();
      expect(state.find((row) => row.appointment_id === first.id)).toMatchObject({ notified_at: null, attempts: 1 });
      expect((await outside()).appointments.find((row) => row.id === first.id)).toMatchObject({ noticePending: true }); // visible to the doctor

      spy.mockRestore();
      await notifier().drain();
      expect(await notices()).toHaveLength(2);
      expect((await tracking()).every((row) => row.notified_at !== null)).toBe(true);
    });

    it('gives up on a notice that keeps failing after a few tries, and leaves it visible for the doctor to ask again', async () => {
      const id = await addRow({});
      const only = (await book(0, monday, '11:30').expect(201)).body;
      await apply(id, '10:00', '11:00').expect(200);
      vi.spyOn(app.get(NotificationsService), 'queueNewTimeRequest').mockRejectedValue(new Error('always failing'));
      for (let n = 0; n < 7; n++) await notifier().runBatch();
      expect(await tracking()).toEqual([expect.objectContaining({ appointment_id: only.id, notified_at: null, attempts: 5 })]);
      expect((await outside()).appointments[0]).toMatchObject({ id: only.id, noticePending: true });
    });
  });

  describe('resolution', () => {
    it('closes the row when the patient moves, and the doctor stops seeing the appointment; payment follows the patient', async () => {
      const id = await addRow({});
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await apply(id, '10:00', '11:00').expect(200);
      await notifier().drain();

      const options = (await alternatives(0, stranded.id).expect(200)).body as { needsNewTime: boolean; alternatives: { date: string; startTime: string }[] };
      expect(options.needsNewTime).toBe(true);
      expect(options.alternatives.length).toBeGreaterThan(0);
      expect(options.alternatives.every((slot) => slot.date > monday || slot.startTime < '11:00')).toBe(true); // nothing in the removed time
      const pick = options.alternatives[0];
      const moved = (await reschedule(0, stranded.id, pick.date, pick.startTime).expect(201)).body;

      expect(moved).toMatchObject({ status: 'CONFIRMED', date: pick.date, startTime: pick.startTime });
      expect(await rows('SELECT status, cancel_reason FROM appointments WHERE id = $1', [stranded.id])).toEqual([{ status: 'CANCELLED', cancel_reason: 'Rescheduled by patient' }]); // history kept
      await notifier().drain();
      expect((await tracking())[0].resolution).toBe('RESCHEDULED');
      expect((await outside()).appointments).toEqual([]);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status IN ('PENDING','CONFIRMED')")).toEqual([{ n: 1 }]); // no duplicate
    });

    it('closes the row as CANCELLED when the doctor cancels as the last resort', async () => {
      const id = await addRow({});
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await apply(id, '10:00', '11:00').expect(200);
      await http().post(`/api/doctor-portal/appointments/${stranded.id}/cancel`).set(as(doctorToken)).send({ reason: 'No time suits' }).expect(200);
      await notifier().drain();
      expect((await tracking())[0].resolution).toBe('CANCELLED');
    });

    it('lets the patient confirm only once: two simultaneous moves of the same appointment make one new appointment', async () => {
      const id = await addRow({ perSlot: 2 });
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await apply(id, '10:00', '11:00').expect(200);
      const next = addDays(monday, 7);
      const results = await Promise.all([reschedule(0, stranded.id, next, '10:00'), reschedule(0, stranded.id, next, '10:30')]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status IN ('PENDING','CONFIRMED')")).toEqual([{ n: 1 }]);
    });

    it('gives the last free place to one of two patients choosing the same alternative at once', async () => {
      const id = await addRow({});
      const one = (await book(0, monday, '11:00').expect(201)).body;
      const two = (await book(1, monday, '11:30').expect(201)).body;
      await apply(id, '10:00', '11:00').expect(200);
      const target = addDays(monday, 7);
      const results = await Promise.all([reschedule(0, one.id, target, '10:00'), reschedule(1, two.id, target, '10:00')]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
      // The loser is untouched: still booked, still outside the hours, and can choose again.
      const loser = results[0].status === 409 ? one : two;
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [loser.id])).toEqual([{ status: 'CONFIRMED' }]);
      const again = await alternatives(results[0].status === 409 ? 0 : 1, loser.id).expect(200);
      expect(again.body.alternatives.some((slot: { date: string; startTime: string }) => slot.date === target && slot.startTime === '10:00')).toBe(false);
    });
  });

  describe('alternatives for the patient', () => {
    it('lists only real open times of the same doctor, never full ones or the removed time, and only for the patient\'s own appointment', async () => {
      const id = await addRow({});
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await book(1, monday, '10:00').expect(201); // a full slot (capacity 1)
      await apply(id, '10:00', '11:00').expect(200);
      const body = (await alternatives(0, stranded.id).expect(200)).body as { alternatives: { date: string; startTime: string }[] };
      expect(body.alternatives).not.toContainEqual(expect.objectContaining({ date: monday, startTime: '10:00' }));
      expect(body.alternatives).toContainEqual(expect.objectContaining({ date: monday, startTime: '10:30' }));
      expect(body.alternatives.some((slot) => slot.date === monday && slot.startTime >= '11:00')).toBe(false);
      await alternatives(1, stranded.id).expect(404); // somebody else's appointment
      await http().get(`/api/appointments/${stranded.id}/alternatives`).expect(401);
    });

    it('never offers the patient the time they already have, even when that slot still has free places', async () => {
      await addRow({ perSlot: 3 });
      const mine = (await book(0, monday, '10:30').expect(201)).body;
      const body = (await alternatives(0, mine.id).expect(200)).body as { needsNewTime: boolean; alternatives: { date: string; startTime: string }[] };
      expect(body.needsNewTime).toBe(false); // an ordinary appointment can use the same list
      expect(body.alternatives).not.toContainEqual(expect.objectContaining({ date: monday, startTime: '10:30' }));
      expect(body.alternatives).toContainEqual(expect.objectContaining({ date: monday, startTime: '10:00' }));
    });

    it('says there is nothing open when the doctor has no other time, and the doctor can then add a one-time session', async () => {
      const id = await addRow({ start: '10:00', end: '11:00' });
      const stranded = (await book(0, monday, '10:30').expect(201)).body;
      await book(1, monday, '10:00').expect(201); // the one slot that stays is taken
      await apply(id, '10:00', '10:30', { startTime: '10:00', endTime: '11:00' }).expect(200);
      const body = (await alternatives(0, stranded.id).expect(200)).body as { needsNewTime: boolean; alternatives: unknown[] };
      expect(body.needsNewTime).toBe(true);
      expect(body.alternatives.length).toBeGreaterThan(0); // the same slot on the following Mondays is still open
      // Take every other Monday away with a day off, so truly nothing is open.
      for (let week = 1; week <= 5; week++) {
        await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'Away') ON CONFLICT DO NOTHING", [doctorId, addDays(monday, week * 7)]);
      }
      const none = (await alternatives(0, stranded.id).expect(200)).body as { alternatives: unknown[] };
      expect(none.alternatives).toEqual([]);
      expect(await rows("SELECT status FROM appointments WHERE id = $1", [stranded.id])).toEqual([{ status: 'CONFIRMED' }]); // nobody cancelled
      // The doctor's own list shows it too, with no times, so they can offer a one-time session.
      expect((await outside()).appointments[0]).toMatchObject({ id: stranded.id, alternatives: [] });
      const extra = addDays(monday, 8);
      await http().post('/api/doctor-portal/availability/one-time').set(as(doctorToken)).send({ date: extra, startTime: '09:00', endTime: '10:00' }).expect(201);
      const offered = (await alternatives(0, stranded.id).expect(200)).body.alternatives as { date: string; startTime: string }[];
      expect(offered[0]).toMatchObject({ date: extra, startTime: '09:00' }); // the extra session is now offered to the stranded patient
      expect(await rows("SELECT count(*)::int AS n FROM availability WHERE recurrence_type = 'WEEKLY'")).toEqual([{ n: 2 }]); // the recurring schedule was only split by the shrink, never touched by the extra session
    });
  });

  describe('volume and pagination', () => {
    const seed = async (count: number) => {
      const id = await addRow({ start: '10:00', end: '12:00', perSlot: Math.max(count, 2) });
      // One crowded slot at 11:30 (a Wave slot holds many people), created directly so the test is quick.
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity)
         SELECT p.id, $1, p.user_id, $2, '11:30', '12:00', 'CONFIRMED', g, $3
           FROM generate_series(1, $3) g
           JOIN LATERAL (SELECT id, user_id FROM patients ORDER BY id OFFSET (g % $4) LIMIT 1) p ON true`,
        [doctorId, monday, count, PATIENTS],
      );
      return id;
    };

    it('previews the full count but lists only the first page, then records and asks every one of them in batches', async () => {
      const count = NOTIFY_BATCH + 70;
      const id = await seed(count);
      const view = (await preview(id, '10:00', '11:30').expect(200)).body as { affectedCount: number; affectedAppointments: unknown[] };
      expect(view.affectedCount).toBe(count);
      expect(view.affectedAppointments).toHaveLength(50);

      const started = Date.now();
      await apply(id, '10:00', '11:30').expect(200);
      const tookMs = Date.now() - started;
      expect(tookMs).toBeLessThan(5_000);
      expect(await tracking()).toHaveLength(count);
      expect(await notices()).toHaveLength(0); // the request sent and queued nothing

      const first = await notifier().runBatch();
      expect(first).toEqual({ claimed: NOTIFY_BATCH, queued: NOTIFY_BATCH });
      expect(await notices()).toHaveLength(NOTIFY_BATCH);
      await notifier().drain();
      expect(await notices()).toHaveLength(count);
      expect((await tracking()).every((row) => row.notified_at !== null)).toBe(true);
    });

    it('pages through the appointments outside the hours without repeats or gaps', async () => {
      const count = 60;
      const id = await seed(count);
      await apply(id, '10:00', '11:30').expect(200);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await outside(`?limit=25${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.appointments.length).toBeLessThanOrEqual(25);
        seen.push(...page.appointments.map((row) => row.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(count);
      await http().get('/api/doctor-portal/appointments/outside-hours?cursor=not-a-cursor').set(as(doctorToken)).expect(400);
    });

    it('finds the affected appointments through the existing index, not by reading every appointment', async () => {
      await seed(300);
      await db.query('ANALYZE appointments');
      await db.query('SET enable_seqscan = off');
      const plan = (
        await rows<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT a.id FROM appointments a
            WHERE a.doctor_id = $1 AND a.status IN ('PENDING','CONFIRMED') AND a.appointment_date BETWEEN $2 AND $3
              AND a.start_time >= '10:00' AND a.end_time <= '12:00' AND (a.start_time < '10:00' OR a.end_time > '11:30')
              AND EXTRACT(DOW FROM a.appointment_date) = 1`,
          [doctorId, today, addDays(today, 30)],
        )
      )
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      await db.query('RESET enable_seqscan');
      expect(plan).toMatch(/Index.*(uq_active_slot_seat|appointments)/);
      expect(plan).not.toMatch(/Seq Scan on appointments/);
    });
  });

  describe('booking racing the change', () => {
    it('never leaves a booked appointment outside the hours without a record of it', async () => {
      for (let round = 0; round < 5; round++) {
        await db.query('DELETE FROM notifications; DELETE FROM schedule_changes; DELETE FROM appointments; DELETE FROM availability;');
        const id = await addRow({ perSlot: 3 });
        await Promise.all([
          ...[0, 1, 2, 3, 4, 5].map((n) => book(n, monday, n % 2 ? '11:00' : '11:30')),
          apply(id, '10:00', '11:00'),
        ]);
        const unrecorded = await rows(
          `SELECT a.id FROM appointments a
            WHERE a.status IN ('PENDING','CONFIRMED') AND a.start_time >= '11:00'
              AND NOT EXISTS (SELECT 1 FROM schedule_change_appointments s WHERE s.appointment_id = a.id)`,
        );
        expect(unrecorded).toEqual([]);
      }
    });
  });
});
