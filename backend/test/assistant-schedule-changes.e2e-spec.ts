// The doctor assistant preparing and applying a schedule change (shortening or extending a session).
//  - the model can only PREPARE: the doctor gets a card listing every affected patient and their alternative times, and nothing changes;
//  - the confirm call takes only the card's signed token. It must be for this doctor, unexpired, untampered, and the schedule must
//    still be exactly as previewed; then the change runs through the existing availability-change service (its locks, minimum-notice
//    rule, acknowledgement, audit row and patient notices), never a copy of it;
//  - a repeat, a double click or a stale card is refused or answered, never run twice; nobody is cancelled or moved;
//  - patients are told by the existing outbox (retried when the mail provider is down), and the doctor can see who was reached.
// The real app, database and services run; only the model and the mail provider are replaced.

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { ScheduleChangeActionsService } from '../src/assistant/actions/schedule-change-actions.service.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { LLM_CLIENT, type LlmClient, type LlmRequest, type LlmResponse } from '../src/assistant/llm/llm-client.js';
import { RateLimiter } from '../src/assistant/rate-limit.js';
import { EMAIL_SENDER } from '../src/auth/email-sender.js';
import { hashPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { runMigrations } from '../src/database/migrator.js';
import { AvailabilityChangeService } from '../src/doctor-portal/availability-change.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
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

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

describe('AI assistant: doctor schedule changes (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let otherDoctorId: string;
  let doctorToken: string;
  let otherDoctorToken: string;
  const patientTokens: string[] = [];
  const mail = { down: false, sent: [] as { to: string; subject: string }[] };

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

  const chat = (token: string, content = 'please do it') => http().post('/api/assistant/chat').set(as(token)).send({ messages: [{ role: 'user', content }] });
  /** The model asks for these tools in one round and then answers. Returns the reply, the card (if any) and what the tools gave back. */
  const converse = async (token: string, calls: { name: string; args?: Record<string, unknown> }[]) => {
    requests.length = 0;
    script = (req) =>
      req.messages.some((message) => message.role === 'tool')
        ? { text: 'Please review the card.', toolCalls: [] }
        : { text: '', toolCalls: calls.map((call, index) => ({ id: `c${index}`, name: call.name, args: call.args ?? {} })) };
    const res = await chat(token);
    const toolMessage = requests.at(-1)?.messages.find((message) => message.role === 'tool');
    const outputs = toolMessage && toolMessage.role === 'tool' ? toolMessage.results.map((result) => result.output as any) : [];
    return { res, card: (res.body.actions?.[0] ?? null) as { ref: string; kind: string; title: string; lines: { label: string; value: string }[]; note?: string; confirmLabel: string; expiresAt: string } | null, outputs, shown: JSON.stringify(outputs) };
  };
  const prepareChange = (args: Record<string, unknown>, token = doctorToken) => converse(token, [{ name: 'prepare_schedule_change', args }]);
  const confirmChange = (token: string, ref: string) => http().post('/api/assistant/schedule-changes/confirm').set(as(token)).send({ token: ref });
  const line = (card: { lines: { label: string; value: string }[] }, label: string) => card.lines.find((entry) => entry.label === label)?.value;

  const hours = async (id: string) => (await rows<{ start_time: string; end_time: string }>('SELECT start_time::text, end_time::text FROM availability WHERE id = $1', [id]))[0];
  const changes = () => rows<{ kind: string; affected_count: number; created_by_user_id: string }>('SELECT kind, affected_count, created_by_user_id FROM schedule_changes ORDER BY created_at');
  const notices = () => rows<{ status: string; to_address: string; attempts: number; last_error: string | null }>("SELECT status, to_address, attempts, last_error FROM notifications WHERE kind = 'needs-new-time' ORDER BY to_address");
  const appointments = () => rows<{ id: string; status: string; start_time: string; appointment_date: string }>('SELECT id, status, start_time::text, appointment_date::text FROM appointments ORDER BY start_time, created_at');
  /** A session on day(6) 9-11 (two places per half hour), a second on day(7) so there are other times, and three patients booked. */
  const scenario = async () => {
    const main = await session(doctorId, day(6));
    await session(doctorId, day(7), '09:00', '12:00');
    await book(0, day(6), '09:00').expect(201);
    await book(1, day(6), '10:00').expect(201);
    await book(2, day(6), '10:30').expect(201);
    await db.query('DELETE FROM notifications'); // the booking emails are not what these tests are about
    return main;
  };
  /** Shortening day(6) to 9-10 leaves the 10:00 and 10:30 bookings outside the hours. */
  const shrinkArgs = { date: day(6), newStartTime: '09:00', newEndTime: '10:00' };

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
    const doctor = async (name: string, email: string) =>
      (await db.query('INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id', [await user(name, email, 'DOCTOR'), clinicId, specialtyId])).rows[0].id as string;
    doctorId = await doctor('Dr. Sched', 'sched@test.local');
    otherDoctorId = await doctor('Dr. Other', 'other@test.local');
    for (let n = 1; n <= 4; n++) {
      const id = await user(`Patient ${n}`, `sp${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000700${n}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: async (message: { to: string; subject: string }) => {
          if (mail.down) throw new Error('mail provider is down');
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
    doctorToken = await login('sched@test.local');
    otherDoctorToken = await login('other@test.local');
    for (let n = 1; n <= 4; n++) patientTokens.push(await login(`sp${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM schedule_changes; DELETE FROM appointments; DELETE FROM schedule_overrides; DELETE FROM availability;');
    mail.down = false;
    mail.sent.length = 0;
    requests.length = 0;
    (app.get(AssistantService) as unknown as { limiter: RateLimiter }).limiter = new RateLimiter(1000, 60_000);
  });

  // After every test: the assistant never cancelled anybody, and no slot holds more people than it allows.
  afterEach(async () => {
    expect(await rows("SELECT id FROM appointments WHERE status = 'CANCELLED'")).toEqual([]);
    expect(await rows("SELECT 1 FROM appointments WHERE status IN ('PENDING','CONFIRMED') GROUP BY doctor_id, appointment_date, start_time HAVING count(*) > max(slot_capacity)")).toEqual([]);
  });

  describe('preparing: a full preview, and nothing happens', () => {
    it('shows every affected patient with other times on the doctor\'s card, and changes nothing', async () => {
      const main = await scenario();
      const before = await appointments();
      const { res, card, outputs } = await prepareChange(shrinkArgs);
      expect(res.status).toBe(200);
      expect(card).toMatchObject({ kind: 'SCHEDULE_CHANGE', title: 'Shorten session hours', confirmLabel: 'Confirm and notify 2 patients' });
      expect(line(card!, 'Hours')).toBe('9:00 AM – 11:00 AM → 9:00 AM – 10:00 AM');
      expect(line(card!, 'Booked patients affected')).toMatch(/^2: they stay booked and are emailed to choose a new time$/);
      const patientLines = card!.lines.filter((entry) => /Patient \d/.test(entry.value));
      expect(patientLines).toHaveLength(2);
      expect(patientLines.map((entry) => entry.value).join('|')).toMatch(/Patient 2: could move to .*9:00 AM/); // other open times are suggested
      expect(card!.note).toMatch(/Nothing is cancelled or moved/);
      expect(outputs[0]).toMatchObject({ prepared: true, preview: { kind: 'SHRINK', bookedPatientsAffected: 2, slotsRemoved: 2 } });

      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
      expect(await changes()).toEqual([]);
      expect(await rows('SELECT 1 FROM notifications')).toEqual([]);
      expect(await rows('SELECT 1 FROM schedule_change_appointments')).toEqual([]);
      expect(await appointments()).toEqual(before);
    });

    it('tells the model only counts: no names, contact details, ids or the confirmation token', async () => {
      await scenario();
      const { card, shown } = await prepareChange(shrinkArgs);
      expect(shown).not.toMatch(/Patient \d|@test\.local|\+91|token|sched@/i);
      expect(JSON.stringify(requests)).not.toContain(card!.ref);
      expect(shown).toMatch(/Never say the change was made/);
    });

    it('a pure extension has no affected patients and a plain confirm button', async () => {
      await session(doctorId, day(6), '09:00', '10:00');
      const { card, outputs } = await prepareChange({ date: day(6), newStartTime: '09:00', newEndTime: '12:00' });
      expect(card).toMatchObject({ title: 'Extend session hours', confirmLabel: 'Confirm change' });
      expect(line(card!, 'Booked patients affected')).toBe('None');
      expect(outputs[0].preview).toMatchObject({ kind: 'EXPAND', slotsAdded: 4, bookedPatientsAffected: 0 });
    });

    it('prepares a weekly session from a start date, and says earlier dates keep their hours', async () => {
      const weekday = WEEKDAYS[dayOfWeek(day(8))];
      await db.query(`INSERT INTO availability (doctor_id, recurrence_type, day_of_week, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes) VALUES ($1, 'WEEKLY', $2, '09:00', '11:00', 'WAVE', 2, 30)`, [doctorId, dayOfWeek(day(8))]);
      await book(0, day(8), '10:30').expect(201);
      const { card } = await prepareChange({ weekday, newStartTime: '09:00', newEndTime: '10:00', applyFrom: day(8) });
      expect(line(card!, 'Earlier dates')).toBe('Keep their current hours');
      expect(line(card!, 'Booked patients affected')).toMatch(/^1:/);
      const done = (await confirmChange(doctorToken, card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'SCHEDULE_CHANGE', outcome: 'DONE', alreadyApplied: false, affectedAppointments: 1 });
      const sessions = await rows<{ end_time: string; effective_to: string | null; effective_from: string | null }>("SELECT end_time::text, effective_from::text, effective_to::text FROM availability WHERE recurrence_type = 'WEEKLY' ORDER BY effective_from NULLS FIRST");
      expect(sessions).toEqual([
        { end_time: '11:00:00', effective_from: null, effective_to: day(7) }, // earlier dates keep what they had
        { end_time: '10:00:00', effective_from: day(8), effective_to: null },
      ]);
    });

    it('refuses to prepare what cannot be applied (no card, and the reasons come back)', async () => {
      await session(doctorId, day(6));
      for (const args of [
        { date: day(6), newStartTime: '11:00', newEndTime: '09:00' }, // backwards
        { date: day(6), newStartTime: '09:00', newEndTime: '11:00' }, // already the hours
      ]) {
        const { card, outputs } = await prepareChange(args);
        expect(card).toBeNull();
        expect(outputs[0]).toMatchObject({ prepared: false });
        expect(outputs[0].cannotBeApplied.length).toBeGreaterThan(0);
      }
      expect(await changes()).toEqual([]);
    });

    it('refuses a change that touches an appointment inside the minimum-notice window, through the existing rule', async () => {
      await scenario();
      const service = app.get(AvailabilityChangeService) as unknown as { config: { scheduleChangeNoticeHours: number } };
      const original = service.config.scheduleChangeNoticeHours;
      service.config.scheduleChangeNoticeHours = 24 * 30; // everything in the next month counts as too close
      try {
        const { card, outputs } = await prepareChange(shrinkArgs);
        expect(card).toBeNull();
        expect(outputs[0].prepared).toBe(false);
        expect(outputs[0].cannotBeApplied.join(' ')).toMatch(/notice|too close|hours/i);
      } finally {
        service.config.scheduleChangeNoticeHours = original;
      }
    });

    it('finds the session itself: unknown, ambiguous, another doctor\'s, and a weekly day named by date', async () => {
      await session(doctorId, day(6), '09:00', '10:00');
      await session(doctorId, day(6), '14:00', '15:00');
      await session(otherDoctorId, day(5)); // only Dr. Other works that day
      const ambiguous = await prepareChange({ date: day(6), newStartTime: '09:00', newEndTime: '09:30' });
      expect(ambiguous.card).toBeNull();
      expect(ambiguous.outputs[0]).toMatchObject({ error: expect.stringMatching(/More than one session/), sessions: [{ startTime: '09:00' }, { startTime: '14:00' }] });
      const picked = await prepareChange({ date: day(6), currentStartTime: '14:00', newStartTime: '14:00', newEndTime: '14:30' });
      expect(picked.card).not.toBeNull();

      const unknown = await prepareChange({ date: day(9), newStartTime: '09:00', newEndTime: '10:00' });
      expect(unknown.outputs[0].error).toMatch(/No matching session/);
      const theirs = await prepareChange({ date: day(5), newStartTime: '09:00', newEndTime: '10:00' }); // cannot reach another doctor's session
      expect(theirs.card).toBeNull();
      expect(theirs.outputs[0].error).toMatch(/No matching session/);
      const both = await prepareChange({ date: day(6), weekday: 'Monday', newStartTime: '09:00', newEndTime: '10:00' });
      expect(both.card).toBeNull();
    });

    it('prepares one card per answer', async () => {
      await scenario();
      const { res, outputs } = await converse(doctorToken, [
        { name: 'prepare_schedule_change', args: shrinkArgs },
        { name: 'prepare_schedule_change', args: { date: day(7), newStartTime: '09:00', newEndTime: '10:00' } },
      ]);
      expect(res.body.actions).toHaveLength(1);
      expect(outputs.filter((output) => output.error)).toHaveLength(1);
      expect(await changes()).toEqual([]);
    });

    it('is not available to a patient, and a patient\'s chat can neither prepare nor change a schedule', async () => {
      await scenario();
      const { res, card, outputs } = await converse(patientTokens[0], [{ name: 'prepare_schedule_change', args: shrinkArgs }]);
      expect(res.status).toBe(200);
      expect(card).toBeNull();
      expect(outputs[0].error).toBeDefined();
      expect(await changes()).toEqual([]);
    });
  });

  describe('confirming: applied through the existing service, patients kept and notified', () => {
    it('applies the change only on confirm, keeps every appointment, writes the audit row and tracks each patient', async () => {
      const main = await scenario();
      const before = await appointments();
      const { card } = await prepareChange(shrinkArgs);
      const done = (await confirmChange(doctorToken, card!.ref).expect(200)).body;
      expect(done).toMatchObject({ kind: 'SCHEDULE_CHANGE', outcome: 'DONE', alreadyApplied: false, affectedAppointments: 2, patientsAsked: 2, restoredAppointments: 0 });
      expect(done.message).toMatch(/2 booked appointments stay booked.*emailed to choose a new time/);

      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '10:00:00' });
      expect(await appointments()).toEqual(before); // nobody was cancelled, moved or changed
      const [audit] = await changes();
      expect(audit).toMatchObject({ kind: 'SHRINK', affected_count: 2 });
      expect(audit.created_by_user_id).toBe((await rows<{ user_id: string }>('SELECT user_id FROM doctors WHERE id = $1', [doctorId]))[0].user_id);
      expect(await rows('SELECT 1 FROM schedule_change_appointments WHERE resolved_at IS NULL')).toHaveLength(2);
    });

    it('emails exactly the affected patients through the existing outbox, and the doctor can see the delivery', async () => {
      await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await confirmChange(doctorToken, card!.ref).expect(200);
      await app.get(ScheduleChangeNotifier).drain();
      expect((await notices()).map((entry) => [entry.to_address, entry.status])).toEqual([
        ['sp2@test.local', 'PENDING'],
        ['sp3@test.local', 'PENDING'],
      ]); // patient 1 (9:00) is still inside the hours and is not contacted
      await app.get(NotificationsService).dispatchDue(new Date(Date.now() + 60_000), 200);
      expect((await notices()).map((entry) => entry.status)).toEqual(['SENT', 'SENT']);
      expect(mail.sent.map((entry) => entry.to).sort((x, y) => x.localeCompare(y))).toEqual(['sp2@test.local', 'sp3@test.local']);

      const report = await converse(doctorToken, [{ name: 'find_scheduling_conflicts' }]);
      const reached = report.outputs[0].outsideWorkingHours.appointments.map((entry: { noticeEmail: string }) => entry.noticeEmail);
      expect(reached).toEqual(['SENT', 'SENT']);
    });

    it('a mail outage never undoes the change: the notice is retried, then delivered', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await confirmChange(doctorToken, card!.ref).expect(200);
      await app.get(ScheduleChangeNotifier).drain();

      mail.down = true;
      await app.get(NotificationsService).dispatchDue(new Date(Date.now() + 60_000), 200);
      const failed = await notices();
      expect(failed.every((entry) => entry.status !== 'SENT' && entry.attempts === 1 && entry.last_error)).toBe(true);
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '10:00:00' }); // the change stands
      expect((await appointments()).every((entry) => entry.status === 'CONFIRMED')).toBe(true);
      const during = await converse(doctorToken, [{ name: 'find_scheduling_conflicts' }]);
      expect(during.outputs[0].outsideWorkingHours.appointments.map((entry: { noticeEmail: string }) => entry.noticeEmail)).toEqual(['PENDING', 'PENDING']); // still being retried, not lost

      mail.down = false;
      await app.get(NotificationsService).dispatchDue(new Date(Date.now() + 3_600_000), 200);
      expect((await notices()).map((entry) => entry.status)).toEqual(['SENT', 'SENT']);
      expect(mail.sent).toHaveLength(2);
    });

    it('extending afterwards releases the waiting appointments (valid again) through the existing flow', async () => {
      const main = await scenario();
      const first = await prepareChange(shrinkArgs);
      await confirmChange(doctorToken, first.card!.ref).expect(200);

      const { card } = await prepareChange({ date: day(6), newStartTime: '09:00', newEndTime: '11:00' });
      expect(card).toMatchObject({ title: 'Extend session hours' });
      expect(line(card!, 'Valid again')).toMatch(/^2 waiting appointments fit these hours and are released$/);
      const done = (await confirmChange(doctorToken, card!.ref).expect(200)).body;
      expect(done).toMatchObject({ outcome: 'DONE', restoredAppointments: 2 });
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
      expect(await rows("SELECT resolution FROM schedule_change_appointments WHERE resolved_at IS NOT NULL")).toEqual([{ resolution: 'COVERED' }, { resolution: 'COVERED' }]);
    });
  });

  describe('replays, double clicks, stale and expired confirmations are safe', () => {
    it('a repeated confirmation is answered as already applied and runs nothing again', async () => {
      await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await confirmChange(doctorToken, card!.ref).expect(200);
      const again = (await confirmChange(doctorToken, card!.ref).expect(200)).body;
      expect(again).toMatchObject({ outcome: 'DONE', alreadyApplied: true, message: expect.stringMatching(/already applied/) });
      await app.get(ScheduleChangeNotifier).drain();
      expect(await changes()).toHaveLength(1);
      expect(await notices()).toHaveLength(2); // two patients, one notice each
    });

    it('two confirmations at once apply the change once', async () => {
      await scenario();
      const { card } = await prepareChange(shrinkArgs);
      const [a, b] = await Promise.all([confirmChange(doctorToken, card!.ref), confirmChange(doctorToken, card!.ref)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.alreadyApplied, b.body.alreadyApplied].filter(Boolean)).toHaveLength(1); // exactly one of the two actually applied it
      await app.get(ScheduleChangeNotifier).drain();
      expect(await changes()).toHaveLength(1);
      expect(await notices()).toHaveLength(2);
    });

    it('an old token cannot shorten the session again after the doctor has put the hours back', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await confirmChange(doctorToken, card!.ref).expect(200);
      const back = await prepareChange({ date: day(6), newStartTime: '09:00', newEndTime: '11:00' });
      await confirmChange(doctorToken, back.card!.ref).expect(200);
      const replay = (await confirmChange(doctorToken, card!.ref).expect(200)).body;
      expect(replay.alreadyApplied).toBe(true);
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' }); // still the restored hours
      expect((await changes()).map((entry) => entry.kind)).toEqual(['SHRINK', 'EXPAND']);
    });

    it('a booking that arrives after the preview makes the card stale: nothing is applied', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await book(3, day(6), '10:00').expect(201); // one more patient now sits in the time being removed
      await db.query('DELETE FROM notifications');
      const res = await confirmChange(doctorToken, card!.ref).expect(409);
      expect(res.body).toMatchObject({ code: 'SCHEDULE_CHANGE_STALE', message: expect.stringMatching(/Nothing was changed/) });
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
      expect(await changes()).toEqual([]);
      expect(await rows('SELECT 1 FROM notifications')).toEqual([]);
      // Preparing again shows the new picture (three patients), and that card works.
      const fresh = await prepareChange(shrinkArgs);
      expect(line(fresh.card!, 'Booked patients affected')).toMatch(/^3:/);
      await confirmChange(doctorToken, fresh.card!.ref).expect(200);
    });

    it('any other schedule change after the preview makes the card stale', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      const other = (await rows<{ id: string }>('SELECT id FROM availability WHERE specific_date = $1', [day(7)]))[0].id;
      await http().post(`/api/doctor-portal/availability/${other}/change`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '13:00', from: { startTime: '09:00', endTime: '12:00' } }).expect(200);
      await confirmChange(doctorToken, card!.ref).expect(409);
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
    });

    it('changing the same session by hand after the preview makes the card stale', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await http().post(`/api/doctor-portal/availability/${main}/change`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '10:30', from: { startTime: '09:00', endTime: '11:00' }, acknowledge: true }).expect(200);
      const res = await confirmChange(doctorToken, card!.ref).expect(409);
      expect(res.body.code).toBe('SCHEDULE_CHANGE_STALE');
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '10:30:00' }); // the doctor's own change stands, untouched
    });

    it('an expired confirmation is refused with nothing changed', async () => {
      const main = await scenario();
      const service = app.get(ScheduleChangeActionsService) as unknown as { config: { assistant: { confirmationMinutes: number } } };
      const original = service.config.assistant.confirmationMinutes;
      service.config.assistant.confirmationMinutes = 0.0005; // 30 ms
      try {
        const { card } = await prepareChange(shrinkArgs);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await confirmChange(doctorToken, card!.ref).expect(410);
        expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
        expect(await changes()).toEqual([]);
      } finally {
        service.config.assistant.confirmationMinutes = original;
      }
    });

    it('a change that is refused when applied (the minimum-notice rule) is refused whole, with nothing written', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      const service = app.get(AvailabilityChangeService) as unknown as { config: { scheduleChangeNoticeHours: number } };
      const original = service.config.scheduleChangeNoticeHours;
      service.config.scheduleChangeNoticeHours = 24 * 30;
      try {
        const res = await confirmChange(doctorToken, card!.ref).expect(409);
        expect(res.body.message).toMatch(/Nothing was changed|notice|too close/i);
      } finally {
        service.config.scheduleChangeNoticeHours = original;
      }
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
      expect(await changes()).toEqual([]);
    });
  });

  describe('who may confirm, and what a token can never be made to do', () => {
    it('only the doctor it was made for, signed in as a doctor', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await confirmChange(otherDoctorToken, card!.ref).expect(403); // another doctor
      await confirmChange(patientTokens[1], card!.ref).expect(403); // a patient
      await http().post('/api/assistant/schedule-changes/confirm').send({ token: card!.ref }).expect(401); // nobody
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
      expect(await changes()).toEqual([]);
    });

    it('a token that was edited, made up, or cut short is rejected', async () => {
      const main = await scenario();
      const { card } = await prepareChange(shrinkArgs);
      const [body, signature] = card!.ref.split('.');
      const edited = JSON.parse(Buffer.from(body, 'base64url').toString());
      edited.e = '09:30'; // ask for different hours than were previewed
      const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`;
      for (const token of [forged, `${body}.${'A'.repeat(signature.length)}`, `${body}`, 'x'.repeat(40), `${body}.${signature}.extra`]) {
        const res = await confirmChange(doctorToken, token).expect(400);
        expect(res.body.code ?? res.body.message).toBeDefined();
      }
      expect(await hours(main)).toEqual({ start_time: '09:00:00', end_time: '11:00:00' });
      expect(await changes()).toEqual([]);
    });

    it('takes only the token: other fields, or none, are rejected', async () => {
      await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await http().post('/api/assistant/schedule-changes/confirm').set(as(doctorToken)).send({ token: card!.ref, startTime: '09:00', endTime: '09:30' }).expect(400);
      await http().post('/api/assistant/schedule-changes/confirm').set(as(doctorToken)).send({}).expect(400);
      await http().post('/api/assistant/schedule-changes/confirm').set(as(doctorToken)).send({ token: 'short' }).expect(400);
      expect(await changes()).toEqual([]);
    });

    it('a patient\'s own confirmation endpoint does not accept a schedule token, and the reverse', async () => {
      await scenario();
      const { card } = await prepareChange(shrinkArgs);
      await http().post(`/api/assistant/actions/${card!.ref}/confirm`).set(as(doctorToken)).send({}).expect(403); // that route is for patients only
      expect(await changes()).toEqual([]);
    });
  });

  it('leaves the other assistant actions alone: the table of patient actions is untouched by schedule changes', async () => {
    await scenario();
    const { card } = await prepareChange(shrinkArgs);
    await confirmChange(doctorToken, card!.ref).expect(200);
    expect(await rows('SELECT 1 FROM assistant_actions')).toEqual([]);
  });
});
