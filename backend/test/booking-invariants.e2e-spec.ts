// Phase C: the booking and capacity engine as a set of invariants, checked through the real API and the real database.
//  I1  never more active appointments in a slot than it has places (capacity 5 demo, simultaneous requests)
//  I2  one patient holds at most one active appointment per doctor for overlapping times (accidental duplicates are refused)
//  I3/I4/I5  a reschedule leaves one active replacement, keeps the payment (moved, never charged twice, never refunded) and the history
//  I9  appointment status transitions are explicit; finished CONFIRMED appointments become COMPLETED, nothing else is overwritten
//  one capacity source: the doctor's view, the patient's view and the doctor's settings all say the same thing
//  a doctor's change racing a patient's booking or confirmation never leaves an appointment outside the hours without a tracking row

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
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
process.env.SCHEDULE_CHANGE_MIN_NOTICE_HOURS = '2';

const PASSWORD = 'Test@1234';
const clinicTimezone = process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata';
const today = clinicNow(clinicTimezone).date;
const FAR = addDays(today, 5);
const FAR2 = addDays(today, 6);
const PATIENTS = 12;

describe('Booking, capacity and lifecycle invariants (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string; // the capacity-5 doctor
  let stackedDoctorId: string; // a one-patient-per-slot doctor with overlapping slots (a new slot every 15 minutes)
  let doctorToken: string;
  const patientTokens: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (patient: number, date: string, startTime: string, forDoctor = doctorId) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId: forDoctor, date, startTime });
  const reschedule = (patient: number, id: string, date: string, startTime: string) => http().post(`/api/appointments/${id}/reschedule`).set(as(patientTokens[patient])).send({ date, startTime });
  const active = (date: string, start?: string) =>
    rows<{ id: string; slot_number: number; slot_capacity: number }>(
      `SELECT id, slot_number, slot_capacity FROM appointments WHERE doctor_id = $1 AND appointment_date = $2 AND status IN ('PENDING','CONFIRMED') ${start ? 'AND start_time = $3' : ''} ORDER BY slot_number`,
      start ? [doctorId, date, start] : [doctorId, date],
    );
  const addRow = async (date: string, extra: { forDoctor?: string; start?: string; end?: string; perSlot?: number; mode?: 'WAVE' | 'STREAM'; recurrence?: 'WEEKLY' | 'ONE_TIME' } = {}) =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, day_of_week, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 30) RETURNING id`,
        [
          extra.forDoctor ?? doctorId,
          extra.recurrence ?? 'WEEKLY',
          extra.recurrence === 'ONE_TIME' ? null : dayOfWeek(date),
          extra.recurrence === 'ONE_TIME' ? date : null,
          extra.start ?? '09:00',
          extra.end ?? '10:00',
          extra.mode ?? 'WAVE',
          extra.mode === 'STREAM' ? 1 : (extra.perSlot ?? 5),
        ],
      )
    ).rows[0].id as string;
  const putWeekly = (hours: unknown[], acknowledge?: boolean) => http().put('/api/doctor-portal/availability/weekly').set(as(doctorToken)).send({ hours, ...(acknowledge ? { acknowledge } : {}) });
  const weekly = (date: string, extra: Record<string, unknown> = {}) => ({ dayOfWeek: dayOfWeek(date), startTime: '09:00', endTime: '10:00', schedulingMode: 'WAVE', capacityPerSlot: 5, slotDurationMinutes: 30, ...extra });
  const statusOf = (id: string) => rows<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [id]).then((r) => r[0].status);

  /** An appointment written directly, for states the booking engine itself can never produce (a time already past, no-show). */
  const insertAppointment = async (patient: number, date: string, start: string, end: string, status: string, seat = 1) => {
    const p = (await rows<{ id: string; user_id: string }>('SELECT p.id, p.user_id FROM patients p JOIN users u ON u.id = p.user_id ORDER BY u.email LIMIT 1 OFFSET $1', [patient]))[0];
    return (
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity, cancelled_at, cancelled_by_user_id, cancel_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5, $9, $10, $11) RETURNING id`,
        [p.id, doctorId, p.user_id, date, start, end, status, seat, status === 'CANCELLED' ? new Date() : null, status === 'CANCELLED' ? p.user_id : null, status === 'CANCELLED' ? 'test' : null],
      )
    ).rows[0].id as string;
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
    const makeDoctor = async (name: string, email: string, interval: number | null) =>
      (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee, slot_interval_minutes) VALUES ($1, $2, $3, 30, 20, 0, $4) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId, interval],
        )
      ).rows[0].id as string;
    doctorId = await makeDoctor('Dr. Five', 'five@test.local', null);
    stackedDoctorId = await makeDoctor('Dr. Stacked', 'stacked@test.local', 15);
    for (let n = 1; n <= PATIENTS; n++) {
      const id = await user(`Patient ${n}`, `bi${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+9190000020${String(n).padStart(2, '0')}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => ({ reference: 'em_1' }) }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('five@test.local');
    for (let n = 1; n <= PATIENTS; n++) patientTokens.push(await login(`bi${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
  });

  // Invariants that hold after every test in this file.
  afterEach(async () => {
    expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time, slot_number HAVING count(*) > 1")).toEqual([]);
    expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time HAVING count(*) > max(slot_capacity)")).toEqual([]);
    // I2 at the database level: no patient has two overlapping active appointments with one doctor.
    expect(
      await rows(`SELECT 1 FROM appointments a JOIN appointments b ON a.patient_id = b.patient_id AND a.doctor_id = b.doctor_id AND a.id < b.id
                   WHERE a.status IN ('PENDING','CONFIRMED') AND b.status IN ('PENDING','CONFIRMED')
                     AND a.appointment_date = b.appointment_date AND a.start_time < b.end_time AND b.start_time < a.end_time`),
    ).toEqual([]);
    // I4: at most one live payment per appointment, and no payment ever attached to a cancelled-by-reschedule appointment alone.
    expect(await rows("SELECT appointment_id FROM payments WHERE status IN ('CREATED','FAILED','PAID') GROUP BY appointment_id HAVING count(*) > 1")).toEqual([]);
  });

  it('the database has every protection against double booking (nothing is missing)', async () => {
    const { missingSchemaGuards } = await import('../src/database/schema-guards.js');
    expect(await missingSchemaGuards(app.get(DataSource))).toEqual([]);
  });

  describe('capacity 5 (the mentor scenario), through the real booking engine', () => {
    it('five patients fill each 30-minute slot; the sixth is refused; nothing exceeds 5', async () => {
      await addRow(FAR);
      for (let n = 0; n < 5; n++) await book(n, FAR, '09:00').expect(201);
      for (let n = 5; n < 10; n++) await book(n, FAR, '09:30').expect(201);
      const sixth = await book(10, FAR, '09:00').expect(409);
      expect(sixth.body.message).toMatch(/full/i);
      await book(11, FAR, '09:30').expect(409);
      for (const start of ['09:00:00', '09:30:00']) {
        const seats = await active(FAR, start);
        expect(seats.map((s) => s.slot_number)).toEqual([1, 2, 3, 4, 5]);
        expect(seats.every((s) => s.slot_capacity === 5)).toBe(true);
      }
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CONFIRMED'")).toEqual([{ n: 10 }]);
    });

    it('eight patients racing for the last two places: exactly two succeed, the rest are refused', async () => {
      await addRow(FAR);
      for (let n = 0; n < 3; n++) await book(n, FAR, '09:00').expect(201);
      const results = await Promise.all([3, 4, 5, 6, 7, 8, 9, 10].map((n) => book(n, FAR, '09:00')));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
      expect((await active(FAR, '09:00:00')).map((s) => s.slot_number)).toEqual([1, 2, 3, 4, 5]);
    });

    it('two patients rescheduling into the last place at once: one wins; the other keeps their original booking', async () => {
      await addRow(FAR);
      for (let n = 0; n < 4; n++) await book(n, FAR, '09:00').expect(201);
      await addRow(FAR2); // a second day, so they have somewhere to move from
      const one = (await book(4, FAR2, '09:00').expect(201)).body;
      const two = (await book(5, FAR2, '09:30').expect(201)).body;
      const results = await Promise.all([reschedule(4, one.id, FAR, '09:00'), reschedule(5, two.id, FAR, '09:00')]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
      const loser = results[0].status === 409 ? one : two;
      expect(await statusOf(loser.id)).toBe('CONFIRMED'); // the original is untouched when the replacement fails
      expect(await active(FAR, '09:00:00')).toHaveLength(5);
    });

    it('raising capacity opens more places at once; lowering it below the bookings keeps everyone and blocks new bookings', async () => {
      await addRow(FAR);
      for (let n = 0; n < 5; n++) await book(n, FAR, '09:00').expect(201);
      await book(5, FAR, '09:00').expect(409);
      await putWeekly([weekly(FAR, { capacityPerSlot: 6 })]).expect(200);
      await book(5, FAR, '09:00').expect(201);
      await putWeekly([weekly(FAR, { capacityPerSlot: 5 })]).expect(200); // 6 are booked: over capacity, but nobody is cancelled
      expect((await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'CONFIRMED'"))[0]).toEqual({ n: 6 });
      await book(6, FAR, '09:00').expect(409);
    });
  });

  describe('one patient, one active appointment per doctor for overlapping times', () => {
    it('booking the same slot twice is refused, with a clear message, and holds no second place', async () => {
      await addRow(FAR);
      await book(0, FAR, '09:00').expect(201);
      const again = await book(0, FAR, '09:00').expect(409);
      expect(again.body).toMatchObject({ code: 'DUPLICATE_APPOINTMENT' });
      expect(again.body.message).toMatch(/already have an appointment with Dr\. Five/);
      expect(await active(FAR, '09:00:00')).toHaveLength(1);
    });

    it('a double click (two identical requests at once) books once', async () => {
      await addRow(FAR);
      const results = await Promise.all([book(0, FAR, '09:00'), book(0, FAR, '09:00'), book(0, FAR, '09:00')]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
      expect(await active(FAR)).toHaveLength(1);
    });

    it('two different times that do not overlap are both allowed', async () => {
      await addRow(FAR);
      await book(0, FAR, '09:00').expect(201);
      await book(0, FAR, '09:30').expect(201);
    });

    it('overlapping slots of the same doctor are refused (a new slot every 15 minutes, 30-minute visits)', async () => {
      await addRow(FAR, { forDoctor: stackedDoctorId, mode: 'STREAM', start: '09:00', end: '12:00' });
      await book(0, FAR, '09:00', stackedDoctorId).expect(201);
      await book(0, FAR, '09:15', stackedDoctorId).expect(409); // the slot engine already treats that window as taken, for this patient or anyone
      await book(1, FAR, '09:15', stackedDoctorId).expect(409);
      await book(0, FAR, '09:30', stackedDoctorId).expect(201); // starts exactly when the first ends
    });

    it('the same time with a different doctor is allowed', async () => {
      await addRow(FAR);
      await addRow(FAR, { forDoctor: stackedDoctorId, mode: 'STREAM', start: '09:00', end: '12:00' });
      await book(0, FAR, '09:00').expect(201);
      await book(0, FAR, '09:00', stackedDoctorId).expect(201);
    });

    it('a cancelled appointment does not block booking the time again', async () => {
      await addRow(FAR);
      const first = (await book(0, FAR, '09:00').expect(201)).body;
      await http().post(`/api/appointments/${first.id}/cancel`).set(as(patientTokens[0])).send({ reason: 'Changed my mind' }).expect(200);
      await book(0, FAR, '09:00').expect(201);
    });

    it('rescheduling into a time that overlaps another of the patient\'s own appointments is refused and leaves the original untouched', async () => {
      await addRow(FAR);
      await addRow(FAR2);
      const a = (await book(0, FAR, '09:00').expect(201)).body;
      const b = (await book(0, FAR2, '09:30').expect(201)).body;
      const refused = await reschedule(0, a.id, FAR2, '09:30').expect(409);
      expect(refused.body.code).toBe('DUPLICATE_APPOINTMENT');
      expect(await statusOf(a.id)).toBe('CONFIRMED');
      expect(await statusOf(b.id)).toBe('CONFIRMED');
      expect(await rows('SELECT 1 FROM appointments WHERE rescheduled_from_id IS NOT NULL')).toEqual([]);
    });
  });

  describe('a reschedule keeps one active replacement, the payment and the history', () => {
    it('moves the single paid payment to the replacement: no second charge, no refund, original kept as history', async () => {
      await addRow(FAR);
      await addRow(FAR2);
      const original = (await book(0, FAR, '09:00').expect(201)).body;
      const patientRow = (await rows<{ id: string }>('SELECT p.id FROM patients p JOIN appointments a ON a.patient_id = p.id WHERE a.id = $1', [original.id]))[0].id;
      await db.query(
        "INSERT INTO payments (appointment_id, patient_id, razorpay_order_id, razorpay_payment_id, amount_paise, status, paid_at) VALUES ($1, $2, 'order_test_1', 'pay_test_1', 75000, 'PAID', now())",
        [original.id, patientRow],
      );
      const moved = (await reschedule(0, original.id, FAR2, '09:30').expect(201)).body;

      expect(await rows('SELECT appointment_id, status, amount_paise FROM payments')).toEqual([{ appointment_id: moved.id, status: 'PAID', amount_paise: 75000 }]);
      expect(await rows('SELECT 1 FROM refunds')).toEqual([]);
      expect(await rows('SELECT status, cancel_reason FROM appointments WHERE id = $1', [original.id])).toEqual([{ status: 'CANCELLED', cancel_reason: 'Rescheduled by patient' }]);
      expect(await rows('SELECT rescheduled_from_id FROM appointments WHERE id = $1', [moved.id])).toEqual([{ rescheduled_from_id: original.id }]);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE rescheduled_from_id = $1 AND status IN ('PENDING','CONFIRMED')", [original.id])).toEqual([{ n: 1 }]);
    });

    it('two simultaneous reschedules of the same appointment create one replacement', async () => {
      await addRow(FAR);
      await addRow(FAR2);
      const original = (await book(0, FAR, '09:00').expect(201)).body;
      const results = await Promise.all([reschedule(0, original.id, FAR2, '09:00'), reschedule(0, original.id, FAR2, '09:30')]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE rescheduled_from_id = $1", [original.id])).toEqual([{ n: 1 }]);
    });
  });

  describe('one capacity source for every screen', () => {
    type Slot = { startTime: string; capacityPerSlot?: number; remaining?: number; booked?: number; status: string };
    const patientView = async (date: string) => ((await http().get(`/api/doctors/${doctorId}/slots?date=${date}`).expect(200)).body.slots as Slot[]).map((s) => ({ start: s.startTime, cap: s.capacityPerSlot, left: s.remaining, booked: s.booked }));
    const doctorView = async (date: string) => {
      const days = (await http().get('/api/doctor-portal/schedule?days=10').set(as(doctorToken)).expect(200)).body.days as { date: string; sessions: { slots: Slot[] }[] }[];
      return days.find((d) => d.date === date)!.sessions.flatMap((s) => s.slots).map((s) => ({ start: s.startTime, cap: s.capacityPerSlot, left: s.remaining, booked: s.booked }));
    };

    it('the patient\'s and the doctor\'s view agree on capacity and places left, before and after bookings', async () => {
      await addRow(FAR);
      expect(await patientView(FAR)).toEqual(await doctorView(FAR));
      expect((await patientView(FAR))[0]).toMatchObject({ cap: 5, left: 5, booked: 0 });
      for (let n = 0; n < 3; n++) await book(n, FAR, '09:00').expect(201);
      expect(await patientView(FAR)).toEqual(await doctorView(FAR));
      expect((await patientView(FAR))[0]).toMatchObject({ cap: 5, left: 2, booked: 3 });
    });

    it('changing the capacity changes every view together, and the settings list says the same number', async () => {
      await addRow(FAR);
      await putWeekly([weekly(FAR, { capacityPerSlot: 3 })]).expect(200);
      expect((await patientView(FAR))[0]).toMatchObject({ cap: 3 });
      expect(await patientView(FAR)).toEqual(await doctorView(FAR));
      const listed = (await http().get('/api/doctor-portal/availability').set(as(doctorToken)).expect(200)).body.weekly as { dayOfWeek: number; capacityPerSlot: number }[];
      expect(listed.find((r) => r.dayOfWeek === dayOfWeek(FAR))?.capacityPerSlot).toBe(3);
    });

    it('two sessions on one day with different capacities: each slot shows its own session\'s capacity, the same on every screen', async () => {
      await addRow(FAR, { start: '09:00', end: '10:00', perSlot: 5 });
      await addRow(FAR, { start: '10:00', end: '11:00', perSlot: 2, recurrence: 'ONE_TIME' });
      const patient = await patientView(FAR);
      expect(patient.map((s) => [s.start, s.cap])).toEqual([['09:00', 5], ['09:30', 5], ['10:00', 2], ['10:30', 2]]);
      expect(patient).toEqual(await doctorView(FAR));
      // The doctor's own list shows both numbers, each against its own session, so 2 and 5 are never mixed up.
      const body = (await http().get('/api/doctor-portal/availability').set(as(doctorToken)).expect(200)).body as { weekly: { capacityPerSlot: number }[]; oneTime: { capacityPerSlot: number }[] };
      expect([body.weekly[0].capacityPerSlot, body.oneTime[0].capacityPerSlot]).toEqual([5, 2]);
    });
  });

  describe('a doctor\'s change racing a patient never leaves someone outside the hours untracked', () => {
    const outsideIds = async () => ((await http().get('/api/doctor-portal/appointments/outside-hours?limit=100').set(as(doctorToken)).expect(200)).body.appointments as { id: string }[]).map((a) => a.id);
    const openTracking = async () => (await rows<{ appointment_id: string }>('SELECT appointment_id FROM schedule_change_appointments WHERE resolved_at IS NULL')).map((r) => r.appointment_id);
    const assertEveryOutsideIsTracked = async () => {
      const tracked = new Set(await openTracking());
      for (const id of await outsideIds()) expect(tracked.has(id), `appointment ${id} is outside the hours but has no open tracking row`).toBe(true);
    };

    it('a booking racing a reduction: either it was refused, or it is affected and tracked like the others', async () => {
      for (let round = 0; round < 6; round++) {
        await db.query('DELETE FROM notifications; DELETE FROM schedule_changes; DELETE FROM appointments; DELETE FROM availability;');
        const row = await addRow(FAR);
        await book(0, FAR, '09:30').expect(201);
        const [shrink, racer] = await Promise.all([
          http().post(`/api/doctor-portal/availability/${row}/change`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '09:30', from: { startTime: '09:00', endTime: '10:00' }, acknowledge: true }),
          book(1, FAR, '09:30'),
        ]);
        expect(shrink.status).toBe(200);
        expect([201, 400, 409]).toContain(racer.status); // 400: the doctor's change removed that time, so there is no such slot any more
        await assertEveryOutsideIsTracked();
        const stranded = await active(FAR, '09:30:00');
        expect((await openTracking()).length).toBe(stranded.length);
        expect(await rows("SELECT 1 FROM appointments WHERE status = 'CANCELLED'")).toEqual([]);
      }
    });

    it('a patient confirming a new time racing a day off: the booking or the refusal, never a silent loss', async () => {
      for (let round = 0; round < 6; round++) {
        await db.query('DELETE FROM notifications; DELETE FROM schedule_overrides; DELETE FROM schedule_changes; DELETE FROM appointments; DELETE FROM availability;');
        await addRow(FAR);
        await addRow(FAR2);
        const original = (await book(0, FAR, '09:30').expect(201)).body;
        const [moved, dayOff] = await Promise.all([
          reschedule(0, original.id, FAR2, '09:00'),
          http().put('/api/doctor-portal/availability/overrides').set(as(doctorToken)).send({ date: FAR2, isAvailable: false, acknowledge: true }),
        ]);
        expect(dayOff.status).toBe(200);
        expect([201, 400, 409]).toContain(moved.status);
        if (moved.status !== 201) expect(await statusOf(original.id)).toBe('CONFIRMED'); // refused: the original is untouched
        else expect(await rows("SELECT count(*)::int AS n FROM appointments WHERE patient_id = (SELECT patient_id FROM appointments WHERE id = $1) AND status IN ('PENDING','CONFIRMED')", [original.id])).toEqual([{ n: 1 }]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await assertEveryOutsideIsTracked();
      }
    });
  });

  describe('appointment lifecycle: explicit transitions and automatic COMPLETED', () => {
    const complete = async (now: Date) => {
      const { completeFinishedAppointments } = await import('../src/appointments/appointment-lifecycle.js');
      return completeFinishedAppointments(app.get(DataSource), now, clinicTimezone);
    };
    const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`); // the test clinic is in India

    it('a CONFIRMED appointment becomes COMPLETED exactly when its end time passes, in the clinic\'s time zone', async () => {
      await addRow(FAR);
      const booked = (await book(0, FAR, '09:00').expect(201)).body; // 09:00-09:30
      expect(await complete(at(FAR, '09:29'))).toBe(0);
      expect(await statusOf(booked.id)).toBe('CONFIRMED');
      expect(await complete(at(FAR, '09:30'))).toBe(1);
      expect(await statusOf(booked.id)).toBe('COMPLETED');
    });

    it('never touches anything else: cancelled, no-show, unpaid holds and future appointments keep their status', async () => {
      const yesterday = addDays(today, -1);
      const cancelled = await insertAppointment(0, yesterday, '09:00', '09:30', 'CANCELLED');
      const noShow = await insertAppointment(1, yesterday, '10:00', '10:30', 'NO_SHOW');
      const hold = await insertAppointment(2, yesterday, '11:00', '11:30', 'PENDING');
      const finished = await insertAppointment(3, yesterday, '12:00', '12:30', 'CONFIRMED');
      await addRow(FAR);
      const future = (await book(4, FAR, '09:00').expect(201)).body;
      expect(await complete(at(addDays(today, 1), '00:00'))).toBe(1);
      expect(await statusOf(cancelled)).toBe('CANCELLED');
      expect(await statusOf(noShow)).toBe('NO_SHOW');
      expect(await statusOf(hold)).toBe('PENDING');
      expect(await statusOf(finished)).toBe('COMPLETED');
      expect(await statusOf(future.id)).toBe('CONFIRMED');
      expect(await rows("SELECT cancel_reason FROM appointments WHERE id = $1", [cancelled])).toEqual([{ cancel_reason: 'test' }]); // history untouched
    });

    it('is idempotent: running it again changes nothing', async () => {
      await insertAppointment(0, addDays(today, -1), '09:00', '09:30', 'CONFIRMED');
      expect(await complete(new Date())).toBe(1);
      const before = await rows('SELECT id, status, updated_at FROM appointments ORDER BY id');
      expect(await complete(new Date())).toBe(0);
      expect(await rows('SELECT id, status, updated_at FROM appointments ORDER BY id')).toEqual(before);
    });

    it('leaves payments and refunds exactly as they were', async () => {
      const id = await insertAppointment(0, addDays(today, -1), '09:00', '09:30', 'CONFIRMED');
      const patientRow = (await rows<{ patient_id: string }>('SELECT patient_id FROM appointments WHERE id = $1', [id]))[0].patient_id;
      await db.query("INSERT INTO payments (appointment_id, patient_id, razorpay_order_id, razorpay_payment_id, amount_paise, status, paid_at) VALUES ($1, $2, 'order_c', 'pay_c', 50000, 'PAID', now())", [id, patientRow]);
      const before = await rows('SELECT * FROM payments');
      await complete(new Date());
      expect(await statusOf(id)).toBe('COMPLETED');
      expect(await rows('SELECT * FROM payments')).toEqual(before);
      expect(await rows('SELECT 1 FROM refunds')).toEqual([]);
    });

    it('the background job itself does it (the first pass runs the upkeep), and a second pass changes nothing', async () => {
      const { JobsService } = await import('../src/jobs/jobs.service.js');
      const finished = await insertAppointment(0, addDays(today, -1), '09:00', '09:30', 'CONFIRMED');
      const jobs = app.get(JobsService, { strict: false });
      await jobs.runOnce();
      expect(await statusOf(finished)).toBe('COMPLETED');
      await jobs.runOnce();
      expect(await statusOf(finished)).toBe('COMPLETED');
    });

    it('a completed appointment cannot be cancelled or rescheduled any more, and shows under Past for the patient', async () => {
      await addRow(FAR);
      await addRow(FAR2);
      const booked = (await book(0, FAR, '09:00').expect(201)).body;
      await complete(at(FAR, '12:00'));
      await http().post(`/api/appointments/${booked.id}/cancel`).set(as(patientTokens[0])).send({}).expect(409);
      await reschedule(0, booked.id, FAR2, '09:00').expect(409);
      const mine = (await http().get('/api/appointments/mine').set(as(patientTokens[0])).expect(200)).body as { id: string; status: string }[];
      expect(mine.find((a) => a.id === booked.id)?.status).toBe('COMPLETED');
    });

    it('an appointment that was waiting for a new time and then finished is closed in the schedule-change records, not left open', async () => {
      const row = await addRow(FAR);
      const booked = (await book(0, FAR, '09:30').expect(201)).body;
      await http().post(`/api/doctor-portal/availability/${row}/change`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '09:30', from: { startTime: '09:00', endTime: '10:00' }, acknowledge: true }).expect(200);
      expect(await rows('SELECT resolution FROM schedule_change_appointments')).toEqual([{ resolution: null }]);
      await complete(at(FAR, '12:00'));
      await app.get(ScheduleChangeNotifier).drain();
      expect(await rows('SELECT resolution FROM schedule_change_appointments WHERE appointment_id = $1', [booked.id])).toEqual([{ resolution: 'CLOSED' }]);
    });
  });
});
