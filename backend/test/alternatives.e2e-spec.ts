// Phase D: a patient whose appointment needs a new time can always find their way. Alternatives are searched from today (not only from the
// appointment's own date), nearest first, a page at a time with a stable cursor, and every time shown is genuinely bookable: capacity,
// date exceptions, unpaid holds, and the patient's own other appointments are all respected. When nothing is open the answer says so
// plainly and the appointment stays booked. The open-days summary lets the calendar show which dates really have room.

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
process.env.RESEND_API_KEY = '';
process.env.BREVO_API_KEY = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const day = (n: number) => addDays(today, n);

interface Alt {
  date: string;
  startTime: string;
  remaining: number;
}
interface AltPage {
  appointmentId: string;
  needsNewTime: boolean;
  alternatives: Alt[];
  nextCursor: string | null;
}

describe('Finding another time (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let doctorToken: string;
  const patientTokens: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const book = (patient: number, date: string, startTime: string) => http().post('/api/appointments').set(as(patientTokens[patient])).send({ doctorId, date, startTime });
  const reschedule = (patient: number, id: string, date: string, startTime: string) => http().post(`/api/appointments/${id}/reschedule`).set(as(patientTokens[patient])).send({ date, startTime });
  const alternatives = async (patient: number, id: string, query = '') => (await http().get(`/api/appointments/${id}/alternatives${query}`).set(as(patientTokens[patient])).expect(200)).body as AltPage;
  /** A one-time session on exactly that date. */
  const session = (date: string, extra: { start?: string; end?: string; perSlot?: number } = {}) =>
    db.query(
      `INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes)
       VALUES ($1, 'ONE_TIME', $2, $3, $4, 'WAVE', $5, 30)`,
      [doctorId, date, extra.start ?? '09:00', extra.end ?? '10:00', extra.perSlot ?? 2],
    );
  const key = (a: Alt) => `${a.date} ${a.startTime}`;

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
        await user('Dr. Alt', 'alt@test.local', 'DOCTOR'),
        clinicId,
        specialtyId,
      ])
    ).rows[0].id as string;
    for (let n = 1; n <= 6; n++) {
      const id = await user(`Patient ${n}`, `alt${n}@test.local`, 'PATIENT');
      await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2)', [id, `+91900000300${n}`]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => ({ reference: 'em_1' }) }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    doctorToken = await login('alt@test.local');
    for (let n = 1; n <= 6; n++) patientTokens.push(await login(`alt${n}@test.local`));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM schedule_changes; DELETE FROM appointments;');
    await db.query('DELETE FROM schedule_overrides; DELETE FROM availability;');
  });

  describe('where the search starts, and in what order', () => {
    it('starts from today, so an earlier open date is offered first even though the appointment is later', async () => {
      await session(day(8));
      await session(day(3)); // earlier than the appointment
      const mine = (await book(0, day(8), '09:00').expect(201)).body;
      const page = await alternatives(0, mine.id);
      expect(page.alternatives[0]).toMatchObject({ date: day(3), startTime: '09:00' });
    });

    it('is chronological, never repeats a time, and never offers the patient\'s own time', async () => {
      for (const n of [4, 6, 9]) await session(day(n), { start: '09:00', end: '11:00' });
      const mine = (await book(0, day(6), '09:30').expect(201)).body;
      const all = (await alternatives(0, mine.id, '?limit=30')).alternatives;
      expect(all.map(key)).toEqual(all.map(key).sort((x, y) => x.localeCompare(y)));
      expect(new Set(all.map(key)).size).toBe(all.length);
      expect(all.map(key)).not.toContain(`${day(6)} 09:30`);
      expect(all).toHaveLength(11); // 3 days x 4 slots, minus the patient's own
    });
  });

  describe('a page at a time', () => {
    it('pages with a cursor: no overlap, no gaps, and the last page says there is no more', async () => {
      for (const n of [4, 6, 9]) await session(day(n), { start: '09:00', end: '11:00' });
      const mine = (await book(0, day(6), '09:30').expect(201)).body;
      const everything = (await alternatives(0, mine.id, '?limit=30')).alternatives.map(key);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: AltPage = await alternatives(0, mine.id, `?limit=4${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.alternatives.length).toBeLessThanOrEqual(4);
        seen.push(...page.alternatives.map(key));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual(everything);
      expect(pages).toBe(3);
      expect(cursor).toBeNull();
    });

    it('a short list has no cursor, and the default page is 8', async () => {
      await session(day(4), { start: '09:00', end: '09:30' });
      await session(day(5), { start: '09:00', end: '12:00' }); // 6 slots
      await session(day(6), { start: '09:00', end: '12:00' });
      const mine = (await book(0, day(4), '09:00').expect(201)).body;
      const first = await alternatives(0, mine.id);
      expect(first.alternatives).toHaveLength(8);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await alternatives(0, mine.id, `?cursor=${first.nextCursor}`);
      expect(second.alternatives).toHaveLength(4);
      expect(second.nextCursor).toBeNull();
    });

    it('refuses a bad limit or cursor, clearly', async () => {
      await session(day(4));
      const mine = (await book(0, day(4), '09:00').expect(201)).body;
      for (const query of ['?limit=0', '?limit=31', '?limit=abc', '?cursor=not-a-cursor', '?cursor=' + Buffer.from('2026-13-45|09:00').toString('base64url')]) {
        await http().get(`/api/appointments/${mine.id}/alternatives${query}`).set(as(patientTokens[0])).expect(400);
      }
    });
  });

  describe('every time shown is genuinely bookable', () => {
    it('leaves out full slots, a day off, an unpaid hold that is still running, and time that overlaps the patient\'s own appointment', async () => {
      await session(day(4), { perSlot: 2 }); // 09:00 and 09:30; two places each
      await session(day(5), { perSlot: 1 }); // one place each
      await session(day(6), { perSlot: 1 });
      await session(day(7), { perSlot: 1 }); // will be a day off
      await session(day(10), { perSlot: 1 }); // the appointment is here
      const mine = (await book(0, day(10), '09:00').expect(201)).body;
      await book(1, day(4), '09:00').expect(201);
      await book(2, day(4), '09:00').expect(201); // 09:00 on day 4 is now full
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'Away')", [doctorId, day(7)]);
      // An unpaid hold that is still running holds its place; one that has run out does not.
      const holder = (await rows<{ id: string; user_id: string }>("SELECT p.id, p.user_id FROM patients p JOIN users u ON u.id = p.user_id WHERE u.email = 'alt4@test.local'"))[0];
      const hold = (start: string, minutes: number) =>
        db.query(
          `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity, hold_expires_at)
           VALUES ($1, $2, $3, $4, $5::time, $5::time + interval '30 minutes', 'PENDING', 1, 1, now() + ($6 || ' minutes')::interval)`,
          [holder.id, doctorId, holder.user_id, day(5), start, String(minutes)],
        );
      await hold('09:00', 10); // still running: the place is taken
      await hold('09:30', -10); // ran out: the place is free again
      // The patient's own other appointment with this doctor, on day 6 at 09:30.
      await book(0, day(6), '09:30').expect(201);

      const shown = (await alternatives(0, mine.id, '?limit=30')).alternatives.map(key);
      expect(shown).not.toContain(`${day(4)} 09:00`); // full
      expect(shown).toContain(`${day(4)} 09:30`);
      expect(shown.filter((k) => k.startsWith(day(7)))).toEqual([]); // day off
      expect(shown).not.toContain(`${day(5)} 09:00`); // live hold
      expect(shown).toContain(`${day(5)} 09:30`); // lapsed hold
      expect(shown).not.toContain(`${day(6)} 09:30`); // the patient's own appointment
      expect(shown).toContain(`${day(6)} 09:00`);
    });

    it('the first few offered times can really be booked: confirming one succeeds', async () => {
      for (const n of [4, 5]) await session(day(n), { perSlot: 1 });
      await session(day(9), { perSlot: 1 });
      const mine = (await book(0, day(9), '09:00').expect(201)).body;
      for (const alt of (await alternatives(0, mine.id, '?limit=3')).alternatives) {
        // Not confirmed one after the other (that would move the same appointment three times): checked as a fresh booking by another patient.
        const probe = await book(5, alt.date, alt.startTime);
        expect(probe.status, `${alt.date} ${alt.startTime}`).toBe(201);
        await http().post(`/api/appointments/${probe.body.id}/cancel`).set(as(patientTokens[5])).send({}).expect(200);
      }
      const first = (await alternatives(0, mine.id)).alternatives[0];
      await reschedule(0, mine.id, first.date, first.startTime).expect(201);
    });

    it('a time taken in the meantime is refused clearly, the original stays booked, and the fresh list no longer has it', async () => {
      await session(day(4), { perSlot: 1 });
      await session(day(5), { perSlot: 1 });
      await session(day(9), { perSlot: 1 });
      const mine = (await book(0, day(9), '09:00').expect(201)).body;
      const stale = (await alternatives(0, mine.id)).alternatives[0];
      await book(1, stale.date, stale.startTime).expect(201); // someone else gets there first
      const refused = await reschedule(0, mine.id, stale.date, stale.startTime);
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/just been booked|full/i);
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CONFIRMED' }]);
      expect((await alternatives(0, mine.id)).alternatives.map(key)).not.toContain(key(stale));
    });
  });

  describe('when nothing is open', () => {
    it('says so plainly: an empty list, no cursor, the appointment still booked and still needing a new time', async () => {
      await session(day(6), { start: '09:00', end: '10:00', perSlot: 1 }); // two slots, both about to be taken
      const mine = (await book(0, day(6), '09:00').expect(201)).body;
      await book(1, day(6), '09:30').expect(201);
      // The doctor shortens the day so the patient's own time is gone, and nothing else exists.
      const row = (await rows<{ id: string }>("SELECT id FROM availability WHERE recurrence_type = 'ONE_TIME'"))[0].id;
      await http().post(`/api/doctor-portal/availability/${row}/change`).set(as(doctorToken)).send({ startTime: '09:30', endTime: '10:00', from: { startTime: '09:00', endTime: '10:00' }, acknowledge: true }).expect(200);
      const page = await alternatives(0, mine.id);
      expect(page).toMatchObject({ needsNewTime: true, alternatives: [], nextCursor: null });
      expect(await rows('SELECT status FROM appointments WHERE id = $1', [mine.id])).toEqual([{ status: 'CONFIRMED' }]);
    });
  });

  describe('old links and access', () => {
    it('after the doctor widens the hours again, the same link says nothing needs to change and still offers other times', async () => {
      await session(day(6), { start: '09:00', end: '10:00', perSlot: 2 });
      await session(day(8));
      const mine = (await book(0, day(6), '09:30').expect(201)).body;
      const row = (await rows<{ id: string }>("SELECT id FROM availability WHERE specific_date = $1", [day(6)]))[0].id;
      await http().post(`/api/doctor-portal/availability/${row}/change`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '09:30', from: { startTime: '09:00', endTime: '10:00' }, acknowledge: true }).expect(200);
      expect((await alternatives(0, mine.id)).needsNewTime).toBe(true);
      const current = (await rows<{ id: string }>("SELECT id FROM availability WHERE specific_date = $1", [day(6)]))[0].id;
      await http().post(`/api/doctor-portal/availability/${current}/change`).set(as(doctorToken)).send({ startTime: '09:00', endTime: '10:00', from: { startTime: '09:00', endTime: '09:30' }, acknowledge: true }).expect(200);
      const page = await alternatives(0, mine.id);
      expect(page.needsNewTime).toBe(false);
      expect(page.alternatives.length).toBeGreaterThan(0);
    });

    it('is only for the patient\'s own appointment, and only for patients', async () => {
      await session(day(4));
      const mine = (await book(0, day(4), '09:00').expect(201)).body;
      await http().get(`/api/appointments/${mine.id}/alternatives`).set(as(patientTokens[1])).expect(404);
      await http().get(`/api/appointments/${mine.id}/alternatives`).set(as(doctorToken)).expect(403);
      await http().get(`/api/appointments/${mine.id}/alternatives`).expect(401);
    });
  });

  describe('which dates really have room (the calendar)', () => {
    type Open = { date: string; open: number; places: number };
    const openDays = async (days = 30) => (await http().get(`/api/doctors/${doctorId}/open-days?days=${days}`).expect(200)).body.days as Open[];

    it('lists each date that has sessions with how many slots and places are open, matching the slots a patient is shown', async () => {
      await session(day(3), { perSlot: 2 });
      await session(day(5), { perSlot: 1 }); // will be full
      await session(day(7), { perSlot: 1 }); // a day off
      await book(0, day(3), '09:00').expect(201);
      await book(1, day(5), '09:00').expect(201);
      await book(2, day(5), '09:30').expect(201);
      await db.query("INSERT INTO schedule_overrides (doctor_id, override_date, is_available, reason) VALUES ($1, $2, false, 'Away')", [doctorId, day(7)]);
      const days = await openDays();
      expect(days.map((d) => d.date)).toEqual([day(3), day(5)]); // the day off has no sessions at all, so it is not listed
      expect(days[0]).toMatchObject({ open: 2, places: 3 }); // 09:00 has one place left, 09:30 has two
      expect(days[1]).toMatchObject({ open: 0, places: 0 }); // a session exists but it is full
      for (const d of days) {
        const slots = (await http().get(`/api/doctors/${doctorId}/slots?date=${d.date}`).expect(200)).body.slots as { status: string; remaining?: number }[];
        expect(d.open).toBe(slots.filter((s) => s.status === 'AVAILABLE').length);
        expect(d.places).toBe(slots.filter((s) => s.status === 'AVAILABLE').reduce((sum, s) => sum + (s.remaining ?? 0), 0));
      }
    });

    it('includes a one-time session on a weekday the doctor does not normally work, and respects the days asked for', async () => {
      await session(day(2));
      await session(day(20));
      expect((await openDays(5)).map((d) => d.date)).toEqual([day(2)]);
      expect((await openDays(30)).map((d) => d.date)).toEqual([day(2), day(20)]);
      await http().get(`/api/doctors/${doctorId}/open-days?days=0`).expect(400);
      await http().get(`/api/doctors/${doctorId}/open-days?days=500`).expect(400);
    });
  });
});
