// Extending hours after a reduction: appointments that were waiting for a new time and are inside the hours again are released
// (COVERED) and their queued messages withdrawn, while everything else stays exactly as it was. Covers partial extensions, date
// exceptions, recurring and one-time sessions, repeated and simultaneous changes, and the race with the background notifier.

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
import { ScheduleChangeNotifier } from '../src/scheduling/schedule-change-notifier.service.js';
import { reconcileCoverage, WITHDRAWN_NOTICE } from '../src/scheduling/schedule-reconciler.js';
import { DataSource } from 'typeorm';

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
const clinicTimezone = process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata';
const today = clinicNow(clinicTimezone).date;
const PATIENTS = 4;
const nextWeekday = (dow: number, from = 1) => {
  for (let offset = from; offset < from + 8; offset++) if (dayOfWeek(addDays(today, offset)) === dow) return addDays(today, offset);
  throw new Error('unreachable');
};

describe('Extending hours releases the appointments a reduction left waiting (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  const patientTokens: string[] = [];
  let sent = 0;
  const monday = nextWeekday(1);

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const notifier = () => app.get(ScheduleChangeNotifier);

  const addRow = async () =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
         VALUES ($1, 'WEEKLY', 1, '10:00', '12:00', 'WAVE', 1, 30) RETURNING id`,
        [doctorId],
      )
    ).rows[0].id as string;
  /** The row that is current now (a change splits a recurring row, so the id moves on). */
  const current = async () => (await rows<{ id: string }>("SELECT id FROM availability WHERE recurrence_type = 'WEEKLY' AND effective_to IS NULL"))[0].id;
  const change = (id: string, startTime: string, endTime: string, from: { startTime: string; endTime: string }, extra: Record<string, unknown> = {}) =>
    http().post(`/api/doctor-portal/availability/${id}/change`).set(as(doctorToken)).send({ startTime, endTime, from, acknowledge: true, ...extra });
  const preview = (id: string, startTime: string, endTime: string) => http().post(`/api/doctor-portal/availability/${id}/change/preview`).set(as(doctorToken)).send({ startTime, endTime });
  const shrink = async () => change(await current(), '10:00', '11:00', { startTime: '10:00', endTime: '12:00' }).expect(200);
  const extend = async (end = '12:00', extra: Record<string, unknown> = {}) => change(await current(), '10:00', end, { startTime: '10:00', endTime: '11:00' }, extra);
  const extendOk = async (end = '12:00', extra: Record<string, unknown> = {}) => {
    const response = await extend(end, extra);
    expect(response.status).toBe(200);
    return response;
  };
  /** Marks the booking confirmations as delivered, so a test can count only the "choose a new time" messages that go out. */
  const settleOthers = () => db.query("UPDATE notifications SET status = 'SENT' WHERE kind <> 'needs-new-time' AND status = 'PENDING'");
  const book = (patient: number, date: string, startTime: string) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime });
  const tracking = () => rows<{ appointment_id: string; notified_at: Date | null; resolution: string | null; resolved_at: Date | null }>('SELECT appointment_id, notified_at, resolution, resolved_at FROM schedule_change_appointments ORDER BY created_at, appointment_id');
  const notices = () => rows<{ appointment_id: string; status: string; last_error: string | null }>("SELECT appointment_id, status, last_error FROM notifications WHERE kind = 'needs-new-time' AND channel = 'email' ORDER BY created_at");
  const outside = async () => (await http().get('/api/doctor-portal/appointments/outside-hours').set(as(doctorToken)).expect(200)).body.appointments as { id: string }[];
  const statuses = () => rows<{ id: string; status: string; appointment_date: string; start_time: string }>('SELECT id, status, appointment_date::text, start_time::text FROM appointments ORDER BY id');
  const clean = async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
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
        await user('Dr. Expand', 'expand@test.local', 'DOCTOR'),
        clinicId,
        specialtyId,
      ])
    ).rows[0].id as string;
    for (let n = 1; n <= PATIENTS; n++) {
      const id = await user(`Patient ${n}`, `p${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000000${n}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: async () => {
          sent++;
          return { reference: 'em_1' };
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('expand@test.local');
    for (let n = 1; n <= PATIENTS; n++) patientTokens.push(await login(`p${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    sent = 0;
    await clean();
  });

  describe('releasing waiting appointments', () => {
    it('closes a notified row as COVERED, withdraws the queued message and leaves a sent one alone; the appointments are untouched', async () => {
      await addRow();
      const a = (await book(0, monday, '11:00').expect(201)).body;
      const b = (await book(1, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();
      expect(await notices()).toHaveLength(2);
      await settleOthers();
      await app.get(NotificationsService).dispatchDue(new Date(), 1); // one of the two goes out
      expect(sent).toBe(1);
      const before = await statuses();

      const done = (await extendOk()).body;

      expect(done).toMatchObject({ kind: 'EXPAND', restoredAppointments: 2, withdrawnNotices: 1 });
      expect((await tracking()).map((row) => row.resolution)).toEqual(['COVERED', 'COVERED']);
      expect((await tracking()).every((row) => row.resolved_at !== null)).toBe(true);
      const messages = await notices();
      expect(messages.filter((row) => row.status === 'SENT')).toHaveLength(1); // an email that already went stays as it was
      expect(messages.filter((row) => row.status === 'CANCELLED')).toEqual([expect.objectContaining({ last_error: WITHDRAWN_NOTICE })]);
      expect(await statuses()).toEqual(before); // nobody moved or cancelled
      expect(await outside()).toEqual([]);
      sent = 0;
      await settleOthers();
      await app.get(NotificationsService).dispatchDue(new Date());
      expect(sent).toBe(0); // the withdrawn one is never sent
      expect([a.id, b.id].sort((x, y) => x.localeCompare(y))).toEqual((await tracking()).map((row) => row.appointment_id).sort((x, y) => x.localeCompare(y)));
    });

    it('closes rows nobody has been told about yet, and nobody is ever asked', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      const done = (await extendOk()).body;
      expect(done.restoredAppointments).toBe(1);
      await notifier().drain();
      expect(await notices()).toEqual([]);
      expect((await tracking())[0]).toMatchObject({ resolution: 'COVERED', notified_at: null });
    });

    it('releases only the appointments the new hours really reach (partial extension)', async () => {
      await addRow();
      const early = (await book(0, monday, '11:00').expect(201)).body;
      const late = (await book(1, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();

      const shown = (await preview(await current(), '10:00', '11:30').expect(200)).body;
      expect(shown).toMatchObject({ kind: 'EXPAND', restoredCount: 1, restoredAppointments: [expect.objectContaining({ id: early.id })] });
      await extendOk('11:30');

      const state = await tracking();
      expect(state.find((row) => row.appointment_id === early.id)?.resolution).toBe('COVERED');
      expect(state.find((row) => row.appointment_id === late.id)).toMatchObject({ resolution: null });
      const messages = await notices();
      expect(messages.find((row) => row.appointment_id === early.id)?.status).toBe('CANCELLED');
      expect(messages.find((row) => row.appointment_id === late.id)?.status).toBe('PENDING'); // still has to choose a new time
      expect((await outside()).map((row) => row.id)).toEqual([late.id]);
    });

    it('does not release appointments the extension does not reach, or ones that were never outside the hours', async () => {
      await addRow();
      await book(0, monday, '10:30').expect(201); // inside all along
      const stranded = (await book(1, monday, '11:30').expect(201)).body;
      await shrink();
      const shown = (await preview(await current(), '10:00', '11:30').expect(200)).body;
      expect(shown.restoredCount).toBe(0);
      await extendOk('11:30');
      expect((await tracking()).map((row) => ({ id: row.appointment_id, resolution: row.resolution }))).toEqual([{ id: stranded.id, resolution: null }]);
    });

    it('never reverts an appointment that was already rescheduled or cancelled, and never touches payments or the new appointment', async () => {
      await addRow();
      const moved = (await book(0, monday, '11:00').expect(201)).body;
      const cancelled = (await book(1, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();
      const next = addDays(monday, 7);
      const rescheduled = (await http().post(`/api/appointments/${moved.id}/reschedule`).set(as(patientTokens[0])).send({ date: next, startTime: '10:00' }).expect(201)).body;
      await http().post(`/api/doctor-portal/appointments/${cancelled.id}/cancel`).set(as(doctorToken)).send({ reason: 'No time suits' }).expect(200);
      await notifier().drain();
      const resolved = await tracking();
      expect(resolved.map((row) => row.resolution).sort((x, y) => String(x).localeCompare(String(y)))).toEqual(['CANCELLED', 'RESCHEDULED']);
      const payments = await rows('SELECT * FROM payments ORDER BY id');
      const before = await statuses();

      const done = (await extendOk()).body;

      expect(done.restoredAppointments).toBe(0);
      expect(await tracking()).toEqual(resolved); // same resolutions, same times
      expect(await statuses()).toEqual(before);
      expect(await rows('SELECT * FROM payments ORDER BY id')).toEqual(payments);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [rescheduled.id])).toEqual([{ status: 'CONFIRMED' }]);
    });

    it('keeps every historical record: the reduction stays as it was and the extension is added beside it', async () => {
      await addRow();
      await book(0, monday, '11:00').expect(201);
      await book(1, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      const reduction = await rows('SELECT * FROM schedule_changes');
      const links = await rows('SELECT change_id, appointment_id FROM schedule_change_appointments ORDER BY appointment_id');

      await extendOk();

      expect(await rows('SELECT * FROM schedule_changes WHERE id = $1', [(reduction[0] as { id: string }).id])).toEqual(reduction);
      expect(await rows('SELECT kind FROM schedule_changes ORDER BY created_at')).toEqual([{ kind: 'SHRINK' }, { kind: 'EXPAND' }]);
      expect(await rows('SELECT change_id, appointment_id FROM schedule_change_appointments ORDER BY appointment_id')).toEqual(links);
      const history = (await http().get('/api/doctor-portal/schedule-changes').set(as(doctorToken)).expect(200)).body.changes as { kind: string; restored: number; unresolved: number; affected: number }[];
      expect(history).toEqual([expect.objectContaining({ kind: 'EXPAND', restored: 2 }), expect.objectContaining({ kind: 'SHRINK', affected: 2, unresolved: 0 })]);
    });

    it('is safe to repeat: reconciling again changes nothing', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      await extendOk();
      const state = { tracking: await tracking(), notices: await notices() };
      const result = await app.get(DataSource).transaction((manager) => reconcileCoverage(manager, doctorId, clinicNow(clinicTimezone)));
      expect(result).toEqual({ restored: 0, withdrawn: 0, more: false });
      expect({ tracking: await tracking(), notices: await notices() }).toEqual(state);
    });

    it('a preview changes nothing', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      const snapshot = async () => ({ changes: await rows('SELECT * FROM schedule_changes'), tracking: await tracking(), notices: await notices(), availability: await rows('SELECT * FROM availability ORDER BY id') });
      const before = await snapshot();
      await preview(await current(), '10:00', '12:00').expect(200);
      expect(await snapshot()).toEqual(before);
    });

    it('only the doctor can extend: a patient is refused', async () => {
      await addRow();
      await http().post(`/api/doctor-portal/availability/${await current()}/change`).set(as(patientTokens[0])).send({ startTime: '10:00', endTime: '12:00', from: { startTime: '10:00', endTime: '12:00' } }).expect(403);
    });
  });

  describe('repeated reductions', () => {
    it('asks again after a reduction when the earlier message was withdrawn unsent', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      await extendOk(); // withdraws the queued message
      await shrink();
      await notifier().drain();
      const messages = await notices();
      expect(messages.map((row) => row.status)).toEqual(['CANCELLED', 'PENDING']); // the patient is asked, because the first one never reached them
    });

    it('does not ask again within 24 hours when the earlier message was sent', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      await settleOthers();
      await app.get(NotificationsService).dispatchDue(new Date());
      await extendOk();
      await shrink();
      await notifier().drain();
      expect((await notices()).map((row) => row.status)).toEqual(['SENT']);
    });
  });

  describe('date exceptions, recurring and one-time sessions', () => {
    const putOverride = (body: Record<string, unknown>) => http().put('/api/doctor-portal/availability/overrides').set(as(doctorToken)).send(body);

    it('a day off keeps the appointment waiting; lifting it releases the appointment', async () => {
      await addRow();
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await shrink();
      await putOverride({ date: monday, isAvailable: false, reason: 'Away' }).expect(200);
      const done = (await extendOk()).body;
      expect(done.restoredAppointments).toBe(0); // the exception decides that day, whatever the weekly hours say
      expect((await outside()).map((row) => row.id)).toEqual([stranded.id]);

      const lifted = (await http().delete(`/api/doctor-portal/availability/overrides/${monday}`).set(as(doctorToken)).expect(200)).body;
      expect(lifted.restoredAppointments).toBe(1);
      expect((await tracking())[0].resolution).toBe('COVERED');
      expect(await outside()).toEqual([]);
    });

    it('a blocked part of the day does not release; replacement hours that cover the appointment do', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await putOverride({ date: monday, isAvailable: false, startTime: '11:00', endTime: '12:00' }).expect(200);
      expect((await extendOk()).body.restoredAppointments).toBe(0);
      const replaced = (await putOverride({ date: monday, isAvailable: true, startTime: '11:00', endTime: '13:00', capacity: 5 }).expect(200)).body;
      expect(replaced.restoredAppointments).toBe(1);
      expect((await tracking())[0].resolution).toBe('COVERED');
    });

    it('a day off added later never releases anyone', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      const off = (await putOverride({ date: addDays(monday, 7), isAvailable: false }).expect(200)).body;
      expect(off.restoredAppointments).toBe(0);
      expect((await tracking())[0].resolution).toBeNull();
    });

    it('a recurring extension from a later date releases only the appointments from that date on', async () => {
      await addRow();
      const first = (await book(0, monday, '11:30').expect(201)).body;
      const second = (await book(1, addDays(monday, 7), '11:30').expect(201)).body;
      await shrink();
      const done = (await extendOk('12:00', { applyFrom: addDays(monday, 7) })).body;
      expect(done.restoredAppointments).toBe(1);
      const state = await tracking();
      expect(state.find((row) => row.appointment_id === second.id)?.resolution).toBe('COVERED');
      expect(state.find((row) => row.appointment_id === first.id)?.resolution).toBeNull();
      expect((await outside()).map((row) => row.id)).toEqual([first.id]);
    });

    it('a one-time session that covers a waiting appointment releases it without asking the patient', async () => {
      await addRow();
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await shrink();
      const added = (await http().post('/api/doctor-portal/availability/one-time').set(as(doctorToken)).send({ date: monday, startTime: '11:00', endTime: '12:00' }).expect(201)).body;
      expect(added.restoredAppointments).toBe(1);
      await notifier().drain();
      expect(await notices()).toEqual([]);
      expect((await tracking())[0]).toMatchObject({ appointment_id: stranded.id, resolution: 'COVERED' });
    });

    it('a one-time session on another date releases nobody', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      const added = (await http().post('/api/doctor-portal/availability/one-time').set(as(doctorToken)).send({ date: addDays(monday, 8), startTime: '09:00', endTime: '10:00' }).expect(201)).body;
      expect(added.restoredAppointments).toBe(0);
      expect((await tracking())[0].resolution).toBeNull();
    });

    it('saving wider weekly hours releases a waiting appointment', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      const saved = (await http().put('/api/doctor-portal/availability/weekly').set(as(doctorToken)).send({ hours: [{ dayOfWeek: 1, startTime: '10:00', endTime: '13:00', schedulingMode: 'WAVE', capacityPerSlot: 1, slotDurationMinutes: 30 }] }).expect(200)).body;
      expect(saved.restoredAppointments).toBe(1);
      expect((await tracking())[0].resolution).toBe('COVERED');
    });

    it('a changed one-time session releases from its own date only', async () => {
      const row = (
        await db.query(
          `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
           VALUES ($1, 'ONE_TIME', $2, '10:00', '12:00', 'WAVE', 1, 30) RETURNING id`,
          [doctorId, monday],
        )
      ).rows[0].id as string;
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await change(row, '10:00', '11:00', { startTime: '10:00', endTime: '12:00' }).expect(200);
      expect((await tracking())[0].appointment_id).toBe(stranded.id);
      const done = (await change(row, '10:00', '12:00', { startTime: '10:00', endTime: '11:00' }).expect(200)).body;
      expect(done.restoredAppointments).toBe(1);
    });
  });

  describe('stale messages are not sent', () => {
    const dispatch = async () => {
      sent = 0;
      await settleOthers();
      await app.get(NotificationsService).dispatchDue(new Date());
    };

    it('sends the message while the appointment is still outside the hours', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      await dispatch();
      expect(sent).toBe(1);
      expect((await notices()).map((row) => row.status)).toEqual(['SENT']);
    });

    it('skips it when the patient has already moved to a new time', async () => {
      await addRow();
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();
      await http().post(`/api/appointments/${stranded.id}/reschedule`).set(as(patientTokens[0])).send({ date: addDays(monday, 7), startTime: '10:00' }).expect(201);
      await dispatch();
      expect(sent).toBe(0); // the other messages were settled first, so nothing at all goes out
      const [message] = await notices();
      expect(message).toMatchObject({ status: 'CANCELLED' });
      expect(message.last_error).toMatch(/^Not sent: the appointment is cancelled/);
    });

    it('skips it when the appointment was cancelled', async () => {
      await addRow();
      const stranded = (await book(0, monday, '11:30').expect(201)).body;
      await shrink();
      await notifier().drain();
      await http().post(`/api/doctor-portal/appointments/${stranded.id}/cancel`).set(as(doctorToken)).send({ reason: 'No time suits' }).expect(200);
      await dispatch();
      expect((await notices())[0]).toMatchObject({ status: 'CANCELLED' });
    });

    it('skips it when the hours were widened and nothing released the appointment yet', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      await db.query("UPDATE availability SET end_time = '12:00' WHERE effective_to IS NULL AND recurrence_type = 'WEEKLY'");
      await dispatch();
      expect((await notices())[0]).toMatchObject({ status: 'CANCELLED', last_error: WITHDRAWN_NOTICE });
    });
  });

  describe('concurrency', () => {
    it('two identical extensions at once: one is applied, the other is refused, and the record is made once', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      const id = await current();
      const results = await Promise.all([
        change(id, '10:00', '12:00', { startTime: '10:00', endTime: '11:00' }),
        change(id, '10:00', '12:00', { startTime: '10:00', endTime: '11:00' }),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409]);
      expect(await rows("SELECT count(*)::int AS n FROM schedule_changes WHERE kind = 'EXPAND'")).toEqual([{ n: 1 }]);
      expect((await tracking())[0].resolution).toBe('COVERED');
    });

    it('waits for a notifier batch that is in progress, then releases the appointment and withdraws the message it just queued', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      const messaging = app.get(NotificationsService);
      const real = messaging.queueNewTimeRequest.bind(messaging);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const started = new Promise<void>((resolve) => (reached = resolve));
      vi.spyOn(messaging, 'queueNewTimeRequest').mockImplementation(async (manager, appointmentId, input) => {
        reached();
        await gate; // the notifier is now holding its rows, part-way through the batch
        return real(manager, appointmentId, input);
      });

      const draining = notifier().drain();
      await started;
      let finished = false;
      const extending = extend().then((response) => {
        finished = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false); // it waits for the batch rather than racing it
      release();
      const [response] = await Promise.all([extending, draining]);

      expect(response.status).toBe(200);
      expect((await tracking())[0].resolution).toBe('COVERED');
      expect((await notices()).map((row) => row.status)).toEqual(['CANCELLED']);
      sent = 0;
      await settleOthers();
      await app.get(NotificationsService).dispatchDue(new Date());
      expect(sent).toBe(0);
    });

    it('however the notifier and the extension interleave, no message is left queued for a released appointment', async () => {
      for (let round = 0; round < 6; round++) {
        await clean();
        await addRow();
        await book(0, monday, '11:00').expect(201);
        await book(1, monday, '11:30').expect(201);
        await shrink();
        await Promise.all([notifier().drain(), extend().then((response) => expect(response.status).toBe(200)), notifier().runBatch()]);
        await notifier().drain();
        const stale = await rows("SELECT n.id FROM notifications n WHERE n.kind = 'needs-new-time' AND n.status = 'PENDING'");
        expect(stale).toEqual([]);
        expect((await tracking()).map((row) => row.resolution)).toEqual(['COVERED', 'COVERED']);
      }
    });

    it('a booking made while the hours are extended lands on one side of it and never double-books', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      const [moved, booking] = await Promise.all([extend(), book(1, monday, '11:30')]);
      expect(moved.status).toBe(200);
      expect([409, 201]).toContain(booking.status);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE start_time = '11:30' AND appointment_date = $1 AND status IN ('PENDING','CONFIRMED')", [monday])).toEqual([{ n: 1 }]);
    });

    it('the background sweep releases anyone a request could not (hours widened outside the application)', async () => {
      await addRow();
      await book(0, monday, '11:30').expect(201);
      await shrink();
      await notifier().drain();
      // Widen the hours directly in the database, as another tool or an operator might.
      await db.query("UPDATE availability SET end_time = '12:00' WHERE effective_to IS NULL AND recurrence_type = 'WEEKLY'");
      await notifier().drain();
      expect((await tracking())[0].resolution).toBe('COVERED');
      expect((await notices()).map((row) => row.status)).toEqual(['CANCELLED']);
    });
  });
});
