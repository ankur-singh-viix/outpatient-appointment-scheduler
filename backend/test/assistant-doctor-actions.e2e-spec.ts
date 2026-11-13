// The doctor assistant preparing four more actions: cancel an appointment, move an appointment, add working hours, block a day.
//  - the model can only PREPARE: the doctor gets a card, the model gets a short note (counts and times, no names or tokens), and nothing changes;
//  - the confirm call takes only the card's signed token: it must be for this doctor, unexpired and untampered, and what was previewed
//    must still be true; the action then runs through the service the app already uses for it, which checks everything again;
//  - a repeat or a double click is answered as already done, also when the server has forgotten the token (a restart);
//  - blocking a day with booked appointments asks the doctor what to do with them and never cancels unless told to.
// The real app, database and services run; only the model and the mail provider are replaced.

import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { DoctorActionsService } from '../src/assistant/actions/doctor-actions.service.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { LLM_CLIENT, type LlmClient, type LlmRequest, type LlmResponse } from '../src/assistant/llm/llm-client.js';
import { RateLimiter } from '../src/assistant/rate-limit.js';
import { EMAIL_SENDER } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { DoctorPortalService } from '../src/doctor-portal/doctor-portal.service.js';
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

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);

describe('AI assistant: doctor cancel, move, add hours and block a day (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let otherDoctorId: string;
  let doctorUserId: string;
  let doctorToken: string;
  let otherDoctorToken: string;
  const patientTokens: string[] = [];
  const mail = { sent: [] as { to: string; subject: string }[] };

  let script: (request: LlmRequest) => LlmResponse | Error;
  const requests: LlmRequest[] = [];
  const fakeModel: LlmClient = {
    configured: true,
    generate: async (req) => {
      requests.push(structuredClone(req));
      const answer = script(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (patient: number, date: string, startTime: string, doctor = doctorId) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId: doctor, date, startTime });
  const session = async (doctor: string, date: string, start = '09:00', end = '11:00') =>
    (
      await db.query(
        `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes) VALUES ($1, 'ONE_TIME', $2, $3, $4, 'WAVE', 2, 30) RETURNING id`,
        [doctor, date, start, end],
      )
    ).rows[0].id as string;

  const converse = async (token: string, calls: { name: string; args?: Record<string, unknown> }[]) => {
    requests.length = 0;
    script = (req) =>
      req.messages.some((message) => message.role === 'tool')
        ? { text: 'Please review the card.', toolCalls: [] }
        : { text: '', toolCalls: calls.map((call, index) => ({ id: `c${index}`, name: call.name, args: call.args ?? {} })) };
    const res = await http().post('/api/assistant/chat').set(as(token)).send({ messages: [{ role: 'user', content: 'please do it' }] });
    const toolMessage = requests.at(-1)?.messages.find((message) => message.role === 'tool');
    const outputs = toolMessage && toolMessage.role === 'tool' ? toolMessage.results.map((result) => result.output as any) : [];
    return { res, card: (res.body.actions?.[0] ?? null) as { ref: string; kind: string; title: string; lines: { label: string; value: string }[]; note?: string; confirmLabel: string } | null, outputs, shown: JSON.stringify(outputs) };
  };
  const prepare = (name: string, args: Record<string, unknown>, token = doctorToken) => converse(token, [{ name, args }]);
  const confirm = (token: string, ref: string) => http().post('/api/assistant/doctor-actions/confirm').set(as(token)).send({ token: ref });
  const line = (card: { lines: { label: string; value: string }[] }, label: string) => card.lines.find((entry) => entry.label === label)?.value;
  /** Pretends the server restarted: it forgets the tokens it had seen, so the records alone must recognise a repeat. */
  const forget = () => ((app.get(DoctorActionsService) as unknown as { done: Map<string, number> }).done.clear());

  const appt = async (patient: number, date: string, startTime: string) =>
    (await rows<{ id: string }>("SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = p.user_id WHERE u.email = $1 AND a.appointment_date = $2 AND a.start_time = $3::time ORDER BY a.created_at DESC LIMIT 1", [`dp${patient + 1}@test.local`, date, startTime]))[0].id;
  const appointments = () => rows<{ id: string; status: string; start_time: string; appointment_date: string; cancel_reason: string | null; cancelled_by_user_id: string | null; rescheduled_from_id: string | null }>('SELECT id, status, start_time::text, appointment_date::text, cancel_reason, cancelled_by_user_id, rescheduled_from_id FROM appointments ORDER BY start_time, created_at');
  const notices = (kind: string) => rows<{ to_address: string; status: string }>("SELECT to_address, status FROM notifications WHERE kind = $1 AND to_address LIKE 'dp%' ORDER BY to_address", [kind]);
  const overrides = () => rows<{ override_date: string; is_available: boolean; start_time: string | null }>('SELECT override_date::text, is_available, start_time::text FROM schedule_overrides');
  const oneTime = (date: string) => rows<{ start_time: string; end_time: string; scheduling_mode: string; capacity_per_slot: number }>("SELECT start_time::text, end_time::text, scheduling_mode, capacity_per_slot FROM availability WHERE recurrence_type = 'ONE_TIME' AND specific_date = $1 ORDER BY start_time", [date]);

  /** Dr. Sched works day(6) 9-11 (two places a half hour) and day(7) 9-12. Patients 1 and 2 are at 9:00, patient 3 at 10:00. */
  const scenario = async () => {
    await session(doctorId, day(6));
    await session(doctorId, day(7), '09:00', '12:00');
    await book(0, day(6), '09:00').expect(201);
    await book(1, day(6), '09:00').expect(201);
    await book(2, day(6), '10:00').expect(201);
    await db.query('DELETE FROM notifications'); // the booking emails are not what these tests are about
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
    const doctor = async (name: string, email: string) => {
      const userId = await user(name, email, 'DOCTOR');
      const id = (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id', [userId, clinicId, specialtyId])).rows[0].id as string;
      return { id, userId };
    };
    const sched = await doctor('Dr. Sched', 'dsched@test.local');
    doctorId = sched.id;
    doctorUserId = sched.userId;
    otherDoctorId = (await doctor('Dr. Other', 'dother@test.local')).id;
    for (let n = 1; n <= 4; n++) {
      const id = await user(`Patient ${n}`, `dp${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000800${n}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: async (message: { to: string; subject: string }) => {
          mail.sent.push({ to: message.to, subject: message.subject });
          return { reference: 'em_1' };
        },
      })
      .overrideProvider(LLM_CLIENT)
      .useValue(fakeModel)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('dsched@test.local');
    otherDoctorToken = await login('dother@test.local');
    for (let n = 1; n <= 4; n++) patientTokens.push(await login(`dp${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM schedule_changes; DELETE FROM appointments; DELETE FROM schedule_overrides; DELETE FROM availability;');
    mail.sent.length = 0;
    requests.length = 0;
    (app.get(AssistantService) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter(1000, 60_000);
    forget();
  });

  // After every test: no slot holds more people than it allows.
  afterEach(async () => {
    expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time HAVING count(*) > max(slot_capacity)")).toEqual([]);
  });

  describe('cancel an appointment', () => {
    it('only prepares: a card with the patient, time, reason and refund note; the model gets no name or token; nothing is cancelled', async () => {
      await scenario();
      const before = await appointments();
      const { res, card, outputs, shown } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      expect(res.status).toBe(200);
      expect(card).toMatchObject({ kind: 'DOCTOR_CANCEL', title: 'Cancel this appointment?', confirmLabel: 'Cancel appointment' });
      expect(line(card!, 'Patient')).toBe('Patient 3');
      expect(line(card!, 'Appointment')).toMatch(/10:00 AM – 10:30 AM/);
      expect(line(card!, 'Reason the patient is told')).toBe('Doctor is unwell');
      expect(line(card!, 'Payment')).toMatch(/refunded in full/);
      expect(outputs[0]).toMatchObject({ prepared: true, preview: { kind: 'CANCEL_APPOINTMENT' } });
      expect(shown).not.toMatch(/Patient \d|@test\.local|\+91|token/i);
      expect(JSON.stringify(requests)).not.toContain(card!.ref);
      expect(await appointments()).toEqual(before);
      expect(await rows('SELECT 1 FROM notifications')).toEqual([]);
    });

    it('asks for what is missing instead of guessing: a reason, and which appointment when several match', async () => {
      await scenario();
      const noReason = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00' });
      expect(noReason.card).toBeNull();
      expect(noReason.outputs[0]).toMatchObject({ prepared: false, missing: ['reason'] });
      const shortReason = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'x' });
      expect(shortReason.outputs[0].missing).toEqual(['reason']);

      const ambiguous = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '09:00', reason: 'Doctor is unwell' });
      expect(ambiguous.card).toBeNull();
      expect(ambiguous.outputs[0].cannotBePrepared[0]).toMatch(/More than one appointment matches.*Patient 1.*Patient 2/);
      const named = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '09:00', patientName: 'patient 2', reason: 'Doctor is unwell' });
      expect(line(named.card!, 'Patient')).toBe('Patient 2');
      const none = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:30', reason: 'Doctor is unwell' });
      expect(none.outputs[0].cannotBePrepared[0]).toMatch(/No active appointment/);
    });

    it('cannot reach another doctor\'s appointment, a cancelled one, or one that has already passed', async () => {
      await scenario();
      await session(otherDoctorId, day(6));
      await book(3, day(6), '09:30', otherDoctorId).expect(201);
      const theirs = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '09:30', reason: 'Doctor is unwell' });
      expect(theirs.card).toBeNull();
      expect(theirs.outputs[0].cannotBePrepared[0]).toMatch(/No active appointment/);
      await db.query("UPDATE appointments SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'test', cancelled_by_user_id = $2 WHERE appointment_date = $1 AND start_time = '10:00'", [day(6), doctorUserId]);
      expect((await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' })).card).toBeNull();
      expect((await prepare('prepare_cancel_appointment', { date: day(-2), reason: 'Doctor is unwell' })).card).toBeNull();
    });

    it('cancels only on confirm, with the reason, recorded as the doctor, and emails the patient', async () => {
      await scenario();
      const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      const done = (await confirm(doctorToken, card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'DOCTOR_CANCEL', outcome: 'DONE', alreadyApplied: false, message: expect.stringMatching(/Cancelled Patient 3's appointment.*10:00 AM.*emailed.*refunded in full/) });
      const cancelled = (await appointments()).filter((row) => row.status === 'CANCELLED');
      expect(cancelled).toEqual([expect.objectContaining({ start_time: '10:00:00', cancel_reason: 'Doctor is unwell', cancelled_by_user_id: doctorUserId })]);
      expect((await appointments()).filter((row) => row.status === 'CONFIRMED')).toHaveLength(2); // the others are untouched
      expect(await notices('booking-cancelled')).toEqual([{ to_address: 'dp3@test.local', status: 'PENDING' }]);
    });

    it('a repeat is answered as already done, with or without the server remembering the token, and cancels nothing twice', async () => {
      await scenario();
      const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      await confirm(doctorToken, card!.ref).expect(200);
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true);
      forget();
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true); // the records show it was cancelled by this doctor
      expect(await notices('booking-cancelled')).toHaveLength(1);
    });

    it('two confirmations at once cancel it once', async () => {
      await scenario();
      const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      const [a, b] = await Promise.all([confirm(doctorToken, card!.ref), confirm(doctorToken, card!.ref)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.alreadyApplied, b.body.alreadyApplied].filter(Boolean)).toHaveLength(1);
      expect(await notices('booking-cancelled')).toHaveLength(1);
    });

    it('a card is stale when the patient cancelled it themselves in the meantime: nothing is applied, no second notice', async () => {
      await scenario();
      const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      await http().post(`/api/appointments/${await appt(2, day(6), '10:00')}/cancel`).set(as(patientTokens[2])).send({}).expect(200);
      await db.query('DELETE FROM notifications');
      await confirm(doctorToken, card!.ref).expect(409);
      expect(await rows('SELECT 1 FROM notifications')).toEqual([]);
      expect((await appointments()).find((row) => row.start_time === '10:00:00')).toMatchObject({ cancelled_by_user_id: expect.not.stringMatching(doctorUserId) });
    });
  });

  describe('move an appointment', () => {
    it('only prepares: checks the new slot, shows from and to, and moves nothing', async () => {
      await scenario();
      const before = await appointments();
      const { card, outputs, shown } = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '10:30' });
      expect(card).toMatchObject({ kind: 'DOCTOR_RESCHEDULE', title: 'Move this appointment?', confirmLabel: 'Move appointment' });
      expect(line(card!, 'From')).toMatch(/10:00 AM – 10:30 AM/);
      expect(line(card!, 'To')).toMatch(/10:30 AM – 11:00 AM/);
      expect(line(card!, 'Payment')).toMatch(/Carries over/);
      expect(outputs[0]).toMatchObject({ prepared: true, preview: { kind: 'RESCHEDULE_APPOINTMENT', patientNotified: true } });
      expect(shown).not.toMatch(/Patient \d|@test\.local|token/i);
      expect(await appointments()).toEqual(before);
      expect(await rows('SELECT 1 FROM notifications')).toEqual([]);
    });

    it('refuses a slot that is not open, a slot that does not exist, the same time, and an unpaid booking', async () => {
      await scenario();
      await book(0, day(7), '10:30').expect(201);
      await book(3, day(7), '10:30').expect(201); // that slot is now full
      const full = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '10:30' });
      expect(full.card).toBeNull();
      expect(full.outputs[0].cannotBePrepared[0]).toMatch(/not open.*Open times that day: 9:00 AM/);
      const nowhere = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '03:00' });
      expect(nowhere.outputs[0].cannotBePrepared[0]).toMatch(/no slot at 3:00 AM/i);
      const same = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(6), newStartTime: '10:00' });
      expect(same.outputs[0].cannotBePrepared[0]).toMatch(/already at that time/);
      await db.query("UPDATE appointments SET status = 'PENDING', hold_expires_at = now() + interval '10 minutes' WHERE appointment_date = $1 AND start_time = '10:00'", [day(6)]);
      const unpaid = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '09:00' });
      expect(unpaid.outputs[0].cannotBePrepared[0]).toMatch(/waiting for the patient to pay/);
    });

    it('moves the patient on confirm through the existing reschedule, keeps a link to the old booking, and emails the new time', async () => {
      await scenario();
      const { card } = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '10:30' });
      const done = (await confirm(doctorToken, card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'DOCTOR_RESCHEDULE', outcome: 'DONE', alreadyApplied: false, message: expect.stringMatching(/Moved Patient 3's appointment.*10:30 AM/) });
      const all = await appointments();
      const old = all.find((row) => row.appointment_date === day(6) && row.start_time === '10:00:00')!;
      const moved = all.find((row) => row.appointment_date === day(7))!;
      expect(old).toMatchObject({ status: 'CANCELLED', cancelled_by_user_id: doctorUserId });
      expect(moved).toMatchObject({ status: 'CONFIRMED', start_time: '10:30:00', rescheduled_from_id: old.id });
      expect(await notices('booking-rescheduled')).toEqual([{ to_address: 'dp3@test.local', status: 'PENDING' }]);
    });

    it('a repeat, with or without the server remembering, moves nothing twice', async () => {
      await scenario();
      const { card } = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '10:30' });
      await confirm(doctorToken, card!.ref).expect(200);
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true);
      forget();
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true);
      expect((await appointments()).filter((row) => row.appointment_date === day(7))).toHaveLength(1);
      expect(await notices('booking-rescheduled')).toHaveLength(1);
    });

    it('a card is stale when the target slot is taken, or the appointment was changed, after the preview', async () => {
      await scenario();
      const first = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '10:30' });
      await book(0, day(7), '10:30').expect(201);
      await book(3, day(7), '10:30').expect(201); // the slot fills up
      const res = await confirm(doctorToken, first.card!.ref).expect(409);
      expect(res.body.code).toBe('DOCTOR_ACTION_STALE');
      expect((await appointments()).find((row) => row.start_time === '10:00:00')).toMatchObject({ status: 'CONFIRMED' }); // not moved

      const second = await prepare('prepare_reschedule_appointment', { date: day(6), startTime: '10:00', newDate: day(7), newStartTime: '11:00' });
      await http().post(`/api/appointments/${await appt(2, day(6), '10:00')}/cancel`).set(as(patientTokens[2])).send({}).expect(200);
      await confirm(doctorToken, second.card!.ref).expect(409);
    });
  });

  describe('add working hours', () => {
    it('only prepares: shows the new slots, and adds nothing', async () => {
      await scenario();
      const { card, outputs } = await prepare('prepare_add_working_hours', { date: day(8), startTime: '17:00', endTime: '19:00' });
      expect(card).toMatchObject({ kind: 'ADD_HOURS', title: 'Add working hours?', confirmLabel: 'Add hours' });
      expect(line(card!, 'Hours')).toBe('5:00 PM – 7:00 PM');
      expect(line(card!, 'New slots')).toMatch(/^4 \(30 minutes each\)$/);
      expect(outputs[0]).toMatchObject({ prepared: true, preview: { kind: 'ADD_WORKING_HOURS', newSlots: 4 } });
      expect(await oneTime(day(8))).toEqual([]);
    });

    it('adds the session on confirm, and patients can book it at once', async () => {
      await scenario();
      const { card } = await prepare('prepare_add_working_hours', { date: day(8), startTime: '17:00', endTime: '19:00', patientsPerSlot: 3 });
      expect(line(card!, 'New slots')).toMatch(/3 patients per slot/);
      const done = (await confirm(doctorToken, card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'ADD_HOURS', outcome: 'DONE', alreadyApplied: false, message: expect.stringMatching(/Added 5:00 PM – 7:00 PM/) });
      expect(await oneTime(day(8))).toEqual([{ start_time: '17:00:00', end_time: '19:00:00', scheduling_mode: 'WAVE', capacity_per_slot: 3 }]);
      await book(0, day(8), '17:30').expect(201);
    });

    it('a repeat or a double click adds one session, with or without the server remembering', async () => {
      await scenario();
      const { card } = await prepare('prepare_add_working_hours', { date: day(8), startTime: '17:00', endTime: '19:00' });
      const [a, b] = await Promise.all([confirm(doctorToken, card!.ref), confirm(doctorToken, card!.ref)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true);
      forget();
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true);
      expect(await oneTime(day(8))).toHaveLength(1);
    });

    it('refuses hours that overlap a session already added, run backwards, are too short, are in the past, or fall on a day off', async () => {
      await scenario();
      const overlap = await prepare('prepare_add_working_hours', { date: day(6), startTime: '10:00', endTime: '12:00' });
      expect(overlap.card).toBeNull();
      expect(overlap.outputs[0].cannotBePrepared[0]).toMatch(/overlaps a session already added.*change its hours/);
      expect((await prepare('prepare_add_working_hours', { date: day(8), startTime: '19:00', endTime: '17:00' })).outputs[0].cannotBePrepared[0]).toMatch(/after the start/);
      expect((await prepare('prepare_add_working_hours', { date: day(8), startTime: '17:00', endTime: '17:15' })).outputs[0].cannotBePrepared[0]).toMatch(/at least 30 minutes/);
      expect((await prepare('prepare_add_working_hours', { date: day(-1), startTime: '17:00', endTime: '19:00' })).outputs[0].cannotBePrepared[0]).toMatch(/today or a future date/);
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'off')", [doctorId, day(9)]);
      const off = await prepare('prepare_add_working_hours', { date: day(9), startTime: '17:00', endTime: '19:00' });
      expect(off.card).toBeNull();
      expect(off.outputs[0].cannotBePrepared[0]).toMatch(/no bookable slots/);
      expect(await oneTime(day(8))).toEqual([]);
    });
  });

  describe('block a day', () => {
    it('blocks a day with no bookings on confirm, and patients can no longer book it', async () => {
      await scenario();
      const { card, outputs } = await prepare('prepare_block_day', { date: day(7) });
      expect(card).toMatchObject({ kind: 'BLOCK_DAY', title: 'Block this day?', confirmLabel: 'Block the day' });
      expect(line(card!, 'Booked appointments')).toBe('None');
      expect(outputs[0]).toMatchObject({ prepared: true, preview: { bookedAppointments: 0, handling: 'NONE_BOOKED' } });
      expect(await overrides()).toEqual([]);
      const done = (await confirm(doctorToken, card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'BLOCK_DAY', outcome: 'DONE', alreadyApplied: false, message: expect.stringMatching(/is now blocked/) });
      expect(await overrides()).toEqual([{ override_date: day(7), is_available: false, start_time: null }]);
      expect((await book(0, day(7), '09:00')).status).toBeGreaterThanOrEqual(400);
      forget();
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true); // already blocked
    });

    it('does not go ahead when appointments are booked: it asks the doctor how to handle them, and changes nothing', async () => {
      await scenario();
      const before = await appointments();
      const { card, outputs } = await prepare('prepare_block_day', { date: day(6) });
      expect(card).toBeNull();
      expect(outputs[0]).toMatchObject({ prepared: false, needsDecision: true, bookedAppointments: 3 });
      expect(outputs[0].options.map((option: { handling: string }) => option.handling)).toEqual(['KEEP_AND_ASK_PATIENTS', 'CANCEL_AND_REFUND']);
      expect(outputs[0].instruction).toMatch(/Do NOT choose for them/);
      expect(await overrides()).toEqual([]);
      expect(await appointments()).toEqual(before);
    });

    it('keep and ask: blocks the day, keeps every appointment booked, and emails each patient to choose a new time, through the existing outbox', async () => {
      await scenario();
      const before = await appointments();
      const { card } = await prepare('prepare_block_day', { date: day(6), handlingOfBookedAppointments: 'KEEP_AND_ASK_PATIENTS' });
      expect(line(card!, 'Booked appointments')).toMatch(/^3: they stay booked and each patient is emailed to choose a new time$/);
      expect(card!.confirmLabel).toBe('Block the day and notify 3');
      expect(card!.lines.filter((entry) => /^Patient \d$/.test(entry.value)).map((entry) => entry.value).sort()).toEqual(['Patient 1', 'Patient 2', 'Patient 3']);
      const done = (await confirm(doctorToken, card!.ref).expect(200)).body;
      expect(done.message).toMatch(/blocked.*3 booked appointments stay booked.*emailed to choose a new time/);
      expect(await overrides()).toHaveLength(1);
      expect(await appointments()).toEqual(before); // nobody cancelled or moved
      expect(await rows('SELECT 1 FROM schedule_change_appointments WHERE resolved_at IS NULL')).toHaveLength(3);
      await app.get(ScheduleChangeNotifier).drain();
      expect(await notices('needs-new-time')).toHaveLength(3);
      await app.get(NotificationsService).dispatchDue(new Date(Date.now() + 60_000), 200);
      expect((await notices('needs-new-time')).map((entry) => entry.status)).toEqual(['SENT', 'SENT', 'SENT']);
    });

    it('cancel and refund: cancels every appointment that day with the reason, emails each patient, then blocks the day', async () => {
      await scenario();
      const { card } = await prepare('prepare_block_day', { date: day(6), handlingOfBookedAppointments: 'CANCEL_AND_REFUND', cancelReason: 'Clinic closed for the day' });
      expect(line(card!, 'Booked appointments')).toMatch(/^3: all will be CANCELLED/);
      expect(line(card!, 'Reason the patients are told')).toBe('Clinic closed for the day');
      expect(card!.confirmLabel).toBe('Cancel 3 and block the day');
      await db.query('DELETE FROM notifications');
      const done = (await confirm(doctorToken, card!.ref).expect(200)).body;
      expect(done.message).toMatch(/blocked.*3 appointments were cancelled.*refunded in full/);
      expect((await appointments()).map((row) => [row.status, row.cancel_reason, row.cancelled_by_user_id])).toEqual(Array(3).fill(['CANCELLED', 'Clinic closed for the day', doctorUserId]));
      expect(await notices('booking-cancelled')).toHaveLength(3);
      expect(await overrides()).toEqual([{ override_date: day(6), is_available: false, start_time: null }]);
      forget();
      expect((await confirm(doctorToken, card!.ref).expect(200)).body.alreadyApplied).toBe(true);
      expect(await notices('booking-cancelled')).toHaveLength(3);
    });

    it('never cancels unless told to: choosing to keep, then confirming, cancels nobody even if the doctor never mentioned a reason', async () => {
      await scenario();
      const { card } = await prepare('prepare_block_day', { date: day(6), handlingOfBookedAppointments: 'KEEP_AND_ASK_PATIENTS' });
      await confirm(doctorToken, card!.ref).expect(200);
      expect((await appointments()).every((row) => row.status === 'CONFIRMED')).toBe(true);
      expect(await rows("SELECT 1 FROM notifications WHERE kind = 'booking-cancelled' AND to_address LIKE 'dp%'")).toEqual([]);
    });

    it('asks for a reason before cancelling, and refuses a day with more appointments than it will cancel in one go', async () => {
      await scenario();
      const noReason = await prepare('prepare_block_day', { date: day(6), handlingOfBookedAppointments: 'CANCEL_AND_REFUND' });
      expect(noReason.card).toBeNull();
      expect(noReason.outputs[0]).toMatchObject({ prepared: false, missing: ['cancelReason'] });
      // Eleven appointments are more than the assistant will cancel in one go.
      await session(doctorId, day(10), '09:00', '14:00');
      for (let n = 0; n < 11; n++) {
        const slot = `${String(9 + Math.floor(n / 2)).padStart(2, '0')}:${n % 2 === 0 ? '00' : '30'}`;
        await db.query(
          `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, slot_capacity, slot_number, status)
           SELECT p.id, $1, p.user_id, $2, $3::time, ($3::time + interval '30 minutes'), 2, 1, 'CONFIRMED' FROM patients p ORDER BY p.id LIMIT 1`,
          [doctorId, day(10), slot],
        );
      }
      const many = await prepare('prepare_block_day', { date: day(10), handlingOfBookedAppointments: 'CANCEL_AND_REFUND', cancelReason: 'Clinic closed' });
      expect(many.card).toBeNull();
      expect(many.outputs[0].cannotBePrepared[0]).toMatch(/more than the 10/);
      expect((await prepare('prepare_block_day', { date: day(10), handlingOfBookedAppointments: 'KEEP_AND_ASK_PATIENTS' })).card).not.toBeNull();
    });

    it('a failure part-way is reported honestly: what was cancelled, what was not, and the day is NOT blocked', async () => {
      await scenario();
      const { card } = await prepare('prepare_block_day', { date: day(6), handlingOfBookedAppointments: 'CANCEL_AND_REFUND', cancelReason: 'Clinic closed for the day' });
      const portal = app.get(DoctorPortalService);
      const original = portal.cancelAppointment.bind(portal);
      let calls = 0;
      const spy = vi.spyOn(portal, 'cancelAppointment').mockImplementation(async (...args) => {
        if (++calls === 2) throw new ConflictException('could not cancel');
        return original(...args);
      });
      try {
        const res = await confirm(doctorToken, card!.ref).expect(409);
        expect(res.body).toMatchObject({ code: 'BLOCK_DAY_PARTIAL', message: expect.stringMatching(/Cancelled 2 of 3.*could not be cancelled.*NOT blocked/) });
      } finally {
        spy.mockRestore();
      }
      expect(await overrides()).toEqual([]);
      expect((await appointments()).filter((row) => row.status === 'CANCELLED')).toHaveLength(2);
    });

    it('refuses a day that is already blocked, has no hours, or has passed', async () => {
      await scenario();
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'off')", [doctorId, day(7)]);
      expect((await prepare('prepare_block_day', { date: day(7) })).outputs[0].cannotBePrepared[0]).toMatch(/already blocked/);
      expect((await prepare('prepare_block_day', { date: day(12) })).outputs[0].cannotBePrepared[0]).toMatch(/nothing to block/);
      expect((await prepare('prepare_block_day', { date: day(-1) })).outputs[0].cannotBePrepared[0]).toMatch(/future date/);
    });

    it('a card is stale when a booking arrives, or one is cancelled, after the preview', async () => {
      await scenario();
      const { card } = await prepare('prepare_block_day', { date: day(6), handlingOfBookedAppointments: 'KEEP_AND_ASK_PATIENTS' });
      await book(3, day(6), '10:30').expect(201);
      const res = await confirm(doctorToken, card!.ref).expect(409);
      expect(res.body.code).toBe('DOCTOR_ACTION_STALE');
      expect(await overrides()).toEqual([]);
      const fresh = await prepare('prepare_block_day', { date: day(6), handlingOfBookedAppointments: 'CANCEL_AND_REFUND', cancelReason: 'Clinic closed' });
      await http().post(`/api/appointments/${await appt(3, day(6), '10:30')}/cancel`).set(as(patientTokens[3])).send({}).expect(200);
      await confirm(doctorToken, fresh.card!.ref).expect(409);
      expect((await appointments()).filter((row) => row.status === 'CANCELLED')).toHaveLength(1); // only the patient's own cancellation
    });
  });

  describe('who may confirm, and what a token can never be made to do', () => {
    it('only the doctor it was made for; not another doctor, a patient, or nobody', async () => {
      await scenario();
      const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      await confirm(otherDoctorToken, card!.ref).expect(403);
      await confirm(patientTokens[2], card!.ref).expect(403);
      await http().post('/api/assistant/doctor-actions/confirm').send({ token: card!.ref }).expect(401);
      expect((await appointments()).every((row) => row.status === 'CONFIRMED')).toBe(true);
    });

    it('an edited, made-up or cut-short token is rejected, and a different kind of card\'s token is not accepted here', async () => {
      await scenario();
      const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      const [body, signature] = card!.ref.split('.');
      const edited = JSON.parse(Buffer.from(body, 'base64url').toString());
      edited.a = (await appt(0, day(6), '09:00')); // point it at another patient's appointment
      const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`;
      for (const token of [forged, `${body}.${'A'.repeat(signature.length)}`, body, 'x'.repeat(40), `${body}.${signature}.extra`]) await confirm(doctorToken, token).expect(400);
      // A schedule-change card is signed for the other endpoint and is refused by this one, and the reverse.
      const schedule = await prepare('prepare_schedule_change', { date: day(7), newStartTime: '09:00', newEndTime: '11:00' });
      await confirm(doctorToken, schedule.card!.ref).expect(400);
      await http().post('/api/assistant/schedule-changes/confirm').set(as(doctorToken)).send({ token: card!.ref }).expect(400);
      expect((await appointments()).every((row) => row.status === 'CONFIRMED')).toBe(true);
    });

    it('takes only the token: other fields, or none, are rejected', async () => {
      await scenario();
      const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
      await http().post('/api/assistant/doctor-actions/confirm').set(as(doctorToken)).send({ token: card!.ref, reason: 'something else' }).expect(400);
      await http().post('/api/assistant/doctor-actions/confirm').set(as(doctorToken)).send({}).expect(400);
      expect((await appointments()).every((row) => row.status === 'CONFIRMED')).toBe(true);
    });

    it('an expired confirmation is refused with nothing changed', async () => {
      await scenario();
      const service = app.get(DoctorActionsService) as unknown as { config: { assistant: { confirmationMinutes: number } } };
      const original = service.config.assistant.confirmationMinutes;
      service.config.assistant.confirmationMinutes = 0.0005; // 30 ms
      try {
        const { card } = await prepare('prepare_cancel_appointment', { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' });
        await new Promise((resolve) => setTimeout(resolve, 150));
        await confirm(doctorToken, card!.ref).expect(410);
        expect((await appointments()).every((row) => row.status === 'CONFIRMED')).toBe(true);
      } finally {
        service.config.assistant.confirmationMinutes = original;
      }
    });

    it('a patient\'s chat has none of these tools, and a doctor gets one card per answer', async () => {
      await scenario();
      for (const name of ['prepare_cancel_appointment', 'prepare_reschedule_appointment', 'prepare_add_working_hours', 'prepare_block_day']) {
        const attempt = await converse(patientTokens[0], [{ name, args: { date: day(6), reason: 'abc', newDate: day(7), newStartTime: '09:00', startTime: '09:00', endTime: '10:00' } }]);
        expect(attempt.card).toBeNull();
        expect(attempt.outputs[0]).toEqual({ error: 'That tool does not exist.' });
      }
      const two = await converse(doctorToken, [
        { name: 'prepare_block_day', args: { date: day(7) } },
        { name: 'prepare_add_working_hours', args: { date: day(8), startTime: '17:00', endTime: '19:00' } },
      ]);
      expect(two.res.body.actions).toHaveLength(1);
      expect(two.outputs.filter((output: { error?: string }) => output.error)).toHaveLength(1);
      expect(await overrides()).toEqual([]);
      expect(await oneTime(day(8))).toEqual([]);
    });

    it('voice and language hints change nothing: the same card, and still only the button confirms', async () => {
      await scenario();
      script = (req) => (req.messages.some((message) => message.role === 'tool') ? { text: 'Card ready.', toolCalls: [] } : { text: '', toolCalls: [{ id: 'c0', name: 'prepare_cancel_appointment', args: { date: day(6), startTime: '10:00', reason: 'Doctor is unwell' } }] });
      const res = await http().post('/api/assistant/chat').set(as(doctorToken)).send({ messages: [{ role: 'user', content: 'haan, cancel kar do' }], voice: true, language: 'hinglish' }).expect(200);
      expect(res.body.actions[0]).toMatchObject({ kind: 'DOCTOR_CANCEL' });
      expect((await appointments()).every((row) => row.status === 'CONFIRMED')).toBe(true); // saying yes cancelled nothing
    });
  });
});
