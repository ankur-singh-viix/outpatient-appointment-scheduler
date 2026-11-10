import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EMAIL_SENDER, type EmailMessage } from '../src/auth/email-sender.js';
import { DeliveryError } from '../src/notifications/delivery-error.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { loadEnvFileIfPresent } from '../src/config.js';
import { createAdminAccount } from '../src/database/admin-account.js';
import { runMigrations } from '../src/database/migrator.js';
import { addDays, clinicNow } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.BACKGROUND_JOBS = 'false';
process.env.FRONTEND_URL = 'https://careslot.example.com/';
process.env.RESEND_API_KEY = ''; // email mode is decided by the tests below, never by a developer's own .env
process.env.EMAIL_FROM = '';

const PASSWORD = 'Test@1234';
const ADMIN_PASSWORD = 'Admin-Pass-123!';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Admin-managed receptionists (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let jwt: JwtService;
  let clinicA: string;
  let clinicB: string;
  let adminToken: string;
  let patientToken: string;
  let doctorToken: string;
  let doctorA: string;
  let doctorB: string;
  const sent: EmailMessage[] = [];
  /** What the fake email provider does next: accept the message, only print it (development), or refuse it. */
  let provider: 'accepts' | 'dev-log' | 'refuses' | 'breaks' = 'accepts';

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const login = (email: string, password = PASSWORD) => http().post('/api/auth/login').send({ email, password });
  const create = (body: Record<string, unknown>) => http().post('/api/admin/receptionists').set(as(adminToken)).send(body);
  const invite = (name = 'Reena Reception', email = 'reena@test.local', clinicId = clinicA) => create({ name, email, clinicId });
  const tokenIn = (message: EmailMessage) => decodeURIComponent(/\/invite\?token=([^\s]+)/.exec(message.text)![1]);
  const lastInviteToken = () => tokenIn(sent[sent.length - 1]);
  const accept = (token: string, password = 'Brand-New-Pass1') => http().post('/api/auth/invitations/accept').send({ token, password });

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);

    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    clinicA = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic A', '1 A St') RETURNING id")).rows[0].id as string;
    clinicB = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic B', '2 B St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string, clinicId: string) =>
      (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee) VALUES ($1, $2, $3, 30, 20, 0) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId],
        )
      ).rows[0].id as string;
    doctorA = await makeDoctor('Dr. Alpha', 'alpha@test.local', clinicA);
    doctorB = await makeDoctor('Dr. Beta', 'beta@test.local', clinicB);
    const patientUser = await user('Pat One', 'p1@test.local', 'PATIENT');
    await db.query('INSERT INTO patients (user_id) VALUES ($1)', [patientUser]);
    expect(await createAdminAccount(db, { name: 'Asha Admin', email: 'Admin@Test.Local', password: ADMIN_PASSWORD })).toBe('created');

    const sender = {
      send: async (message: EmailMessage) => {
        if (provider === 'refuses') throw new DeliveryError('Resend responded with HTTP 403 (validation_error: You can only send testing emails to your own email address)', false, 'validation_error');
        if (provider === 'breaks') throw new Error('connection reset while posting the message');
        sent.push(message);
        return provider === 'dev-log' ? { mode: 'dev-log' as const } : { reference: 'em_test_123' };
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue(sender).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);
    adminToken = (await login('admin@test.local', ADMIN_PASSWORD).expect(200)).body.accessToken as string;
    patientToken = (await login('p1@test.local').expect(200)).body.accessToken as string;
    doctorToken = (await login('alpha@test.local').expect(200)).body.accessToken as string;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    provider = 'accepts';
    await db.query('DELETE FROM notifications; DELETE FROM payment_events; DELETE FROM refunds; DELETE FROM payments; DELETE FROM appointments; DELETE FROM availability;');
    await db.query("DELETE FROM users WHERE role = 'RECEPTIONIST'"); // assignments go with them
  });

  describe('who may manage receptionists', () => {
    it('is for administrators only', async () => {
      const body = { name: 'Reena Reception', email: 'reena@test.local', clinicId: clinicA };
      await http().get('/api/admin/receptionists').expect(401);
      await http().post('/api/admin/receptionists').send(body).expect(401);
      for (const token of [patientToken, doctorToken]) {
        await http().get('/api/admin/receptionists').set(as(token)).expect(403);
        await http().post('/api/admin/receptionists').set(as(token)).send(body).expect(403);
      }
      expect(await rows("SELECT 1 FROM users WHERE role = 'RECEPTIONIST'")).toEqual([]);
    });

    it('is closed to receptionists themselves', async () => {
      await invite().expect(201);
      const session = (await accept(lastInviteToken()).expect(200)).body.accessToken as string;
      await http().get('/api/admin/receptionists').set(as(session)).expect(403);
      await http().put(`/api/admin/receptionists/${(await rows<{ id: string }>("SELECT id FROM users WHERE role = 'RECEPTIONIST'"))[0].id}/clinic`).set(as(session)).send({ clinicId: clinicB }).expect(403);
    });
  });

  describe('creating a receptionist', () => {
    it('creates the account at one clinic with no password, and emails a one-time link', async () => {
      const created = await invite('Reena Reception', 'Reena@Test.Local').expect(201);
      expect(created.body).toMatchObject({ name: 'Reena Reception', email: 'reena@test.local', clinic: { id: clinicA, name: 'Clinic A' }, invitePending: true, invite: { status: 'sent' } });
      expect(JSON.stringify(created.body)).not.toMatch(/token|invite\?/i); // the link only ever goes to the receptionist's inbox
      expect(await rows('SELECT role, password_hash FROM users WHERE email = $1', ['reena@test.local'])).toEqual([{ role: 'RECEPTIONIST', password_hash: null }]);
      expect(await rows('SELECT clinic_id FROM receptionist_assignments')).toEqual([{ clinic_id: clinicA }]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'reena@test.local', subject: expect.stringMatching(/invited/i) });
      expect(sent[0].text).toMatch(/^.*Clinic A/m);
      expect(sent[0].text).toContain('https://careslot.example.com/invite?token='); // FRONTEND_URL, with no doubled slash
      expect(sent[0].text).toMatch(/72 hours/);
    });

    it('cannot sign in until the receptionist has chosen a password', async () => {
      await invite().expect(201);
      await login('reena@test.local', PASSWORD).expect(401);
      await login('reena@test.local', '').expect(400);
    });

    it('refuses a duplicate email (in any case), an unknown clinic, and anything but name, email and clinic', async () => {
      await invite().expect(201);
      expect((await invite('Someone Else', 'REENA@test.local').expect(409)).body.message).toMatch(/already exists/i);
      expect((await invite('Pat Again', 'p1@test.local').expect(409)).body.message).toMatch(/already exists/i);
      await invite('New Person', 'new@test.local', '00000000-0000-4000-8000-000000000000').expect(400);
      await create({ name: 'N', email: 'new@test.local', clinicId: clinicA }).expect(400); // name too short
      await create({ name: 'New Person', email: 'not-an-email', clinicId: clinicA }).expect(400);
      await create({ name: 'New Person', email: 'new@test.local' }).expect(400); // no clinic
      await create({ name: 'New Person', email: 'new@test.local', clinicId: clinicA, role: 'ADMIN' }).expect(400); // the role is not up to the request
      await create({ name: 'New Person', email: 'new@test.local', clinicId: clinicA, password: 'Chosen-For-Them1' }).expect(400); // nor the password
      expect(await rows("SELECT count(*)::int AS n FROM users WHERE role = 'RECEPTIONIST'")).toEqual([{ n: 1 }]);
    });

    it('still creates the account when the provider refuses, says why, and lets the admin resend', async () => {
      provider = 'refuses';
      const created = await invite().expect(201);
      expect(created.body).toMatchObject({
        invitePending: true,
        invite: { status: 'failed', reason: expect.stringMatching(/Resend responded with HTTP 403 \(validation_error/) },
      });
      expect(sent).toHaveLength(0);
      provider = 'accepts';
      const resent = await http().post(`/api/admin/receptionists/${created.body.id}/invitation`).set(as(adminToken)).expect(200);
      expect(resent.body).toMatchObject({ invite: { status: 'sent' } });
      expect(sent).toHaveLength(1);
      await accept(lastInviteToken()).expect(200);
    });

    it('gives only a generic reason when something other than the provider breaks', async () => {
      provider = 'breaks';
      const created = await invite().expect(201);
      expect(created.body.invite).toEqual({ status: 'failed', reason: 'The email could not be sent.' });
      expect(JSON.stringify(created.body)).not.toMatch(/connection reset/);
    });

    it('says "logged", never "sent", when only the development stand-in ran', async () => {
      provider = 'dev-log';
      const created = await invite().expect(201);
      expect(created.body.invite).toEqual({ status: 'logged' });
      const resent = await http().post(`/api/admin/receptionists/${created.body.id}/invitation`).set(as(adminToken)).expect(200);
      expect(resent.body.invite).toEqual({ status: 'logged' });
    });

    it('never returns the invitation link or token, in any outcome, on create, resend or list', async () => {
      for (const mode of ['accepts', 'dev-log', 'refuses', 'breaks'] as const) {
        provider = mode;
        const created = await create({ name: 'Mode Test', email: `${mode}@test.local`, clinicId: clinicA }).expect(201);
        const resent = await http().post(`/api/admin/receptionists/${created.body.id}/invitation`).set(as(adminToken)).expect(200);
        const listed = await http().get('/api/admin/receptionists').set(as(adminToken)).expect(200);
        for (const body of [created.body, resent.body, listed.body]) {
          expect(JSON.stringify(body), mode).not.toMatch(/token|\/invite|eyJ/i);
        }
      }
    });

    it('lists receptionists with their clinic and whether they have set up their account', async () => {
      await invite('Reena Reception', 'reena@test.local', clinicA).expect(201);
      await invite('Raj Reception', 'raj@test.local', clinicB).expect(201);
      await accept(sent[1] ? tokenIn(sent[1]) : '').expect(200);
      const list = (await http().get('/api/admin/receptionists').set(as(adminToken)).expect(200)).body as { name: string; clinic: { name: string }; invitePending: boolean }[];
      expect(list.map((entry) => [entry.name, entry.clinic.name, entry.invitePending])).toEqual([
        ['Raj Reception', 'Clinic B', false],
        ['Reena Reception', 'Clinic A', true],
      ]);
      expect(JSON.stringify(list)).not.toMatch(/password|hash/i);
    });
  });

  describe('how email is delivered', () => {
    const status = () => http().get('/api/admin/email-status').set(as(adminToken));
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of ['NODE_ENV', 'RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('is for administrators only', async () => {
      await http().get('/api/admin/email-status').expect(401);
      await http().get('/api/admin/email-status').set(as(patientToken)).expect(403);
      await http().get('/api/admin/email-status').set(as(doctorToken)).expect(403);
    });

    it('is the terminal in development without a key: nothing is emailed, and it says so', async () => {
      expect((await status().expect(200)).body).toEqual({ mode: 'dev-log', testingSender: false, problem: null });
    });

    it('is the provider with a key, and flags the testing sender, which reaches only the account owner', async () => {
      process.env.RESEND_API_KEY = 're_a_secret_key';
      process.env.EMAIL_FROM = 'CareSlot <onboarding@resend.dev>';
      expect((await status().expect(200)).body).toEqual({ mode: 'provider', testingSender: true, problem: null });
      process.env.EMAIL_FROM = 'CareSlot <no-reply@clinic.example>';
      expect((await status().expect(200)).body).toEqual({ mode: 'provider', testingSender: false, problem: null });
    });

    it('is off in production without a verified sender, with a reason that never contains a key', async () => {
      process.env.NODE_ENV = 'production';
      expect((await status().expect(200)).body).toEqual({ mode: 'disabled', testingSender: false, problem: 'No email provider key is set (BREVO_API_KEY or RESEND_API_KEY).' });
      process.env.RESEND_API_KEY = 're_a_secret_key';
      process.env.EMAIL_FROM = 'CareSlot <onboarding@resend.dev>';
      const refused = (await status().expect(200)).body as { mode: string; problem: string };
      expect(refused.mode).toBe('disabled');
      expect(refused.problem).toMatch(/testing sender.*verified in Resend/);
      expect(JSON.stringify(refused)).not.toContain('re_a_secret_key');
      process.env.EMAIL_FROM = 'CareSlot <no-reply@clinic.example>';
      expect((await status().expect(200)).body).toMatchObject({ mode: 'provider', problem: null });
    });

    it('reports Brevo as a provider once its key and a sender are set, and off again without the sender', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.RESEND_API_KEY;
      process.env.BREVO_API_KEY = 'xkeysib-a-secret-key';
      delete process.env.EMAIL_FROM;
      const missing = (await status().expect(200)).body as { mode: string; problem: string };
      expect(missing.mode).toBe('disabled');
      expect(missing.problem).toMatch(/EMAIL_FROM is not set.*verified in Brevo/);
      expect(JSON.stringify(missing)).not.toContain('xkeysib-a-secret-key');
      process.env.EMAIL_FROM = 'CareSlot <no-reply@clinic.example>';
      expect((await status().expect(200)).body).toEqual({ mode: 'provider', testingSender: false, problem: null });
      delete process.env.BREVO_API_KEY;
    });
  });

  describe('the invitation link', () => {
    it('shows whose account it is, sets the password once, and signs the receptionist in', async () => {
      await invite().expect(201);
      const token = lastInviteToken();
      expect((await http().post('/api/auth/invitations/inspect').send({ token }).expect(200)).body).toEqual({ name: 'Reena Reception', email: 'reena@test.local' });
      await accept(token, 'short').expect(400);
      expect(await rows('SELECT password_hash FROM users WHERE email = $1', ['reena@test.local'])).toEqual([{ password_hash: null }]); // a refused password changes nothing

      const session = (await accept(token, 'Brand-New-Pass1').expect(200)).body as { accessToken: string; user: { role: string; email: string } };
      expect(session.user).toMatchObject({ role: 'RECEPTIONIST', email: 'reena@test.local' });
      const [{ password_hash }] = await rows<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', ['reena@test.local']);
      expect(password_hash).not.toContain('Brand-New-Pass1');
      expect(await verifyPassword('Brand-New-Pass1', password_hash)).toBe(true);
      expect((await login('reena@test.local', 'Brand-New-Pass1').expect(200)).body.user.role).toBe('RECEPTIONIST');
      await login('reena@test.local', PASSWORD).expect(401);
      await http().get('/api/receptionist/doctors').set(as(session.accessToken)).expect(200);
    });

    it('works only once, even when two people open it at the same moment', async () => {
      await invite().expect(201);
      const token = lastInviteToken();
      const results = await Promise.all([accept(token, 'First-Choice-Pass1'), accept(token, 'Second-Choice-Pass2'), accept(token, 'Third-Choice-Pass3')]);
      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409, 409]);
      const winner = results.find((result) => result.status === 200)!;
      expect(winner.body.user.role).toBe('RECEPTIONIST');
      await accept(token).expect(409);
      expect((await http().post('/api/auth/invitations/inspect').send({ token }).expect(409)).body.message).toMatch(/already been used/i);
    });

    it('rejects links that are expired, forged, or of another kind', async () => {
      const created = (await invite().expect(201)).body as { id: string };
      const expired = await jwt.signAsync({ purpose: 'receptionist-invite', sub: created.id }, { expiresIn: '1s' });
      await sleep(1500);
      await accept(expired).expect(401);
      await http().post('/api/auth/invitations/inspect').send({ token: expired }).expect(401);

      const real = lastInviteToken();
      await accept(`${real.slice(0, -4)}AAAA`).expect(401); // tampered signature
      await accept('x'.repeat(40)).expect(401);
      const signup = await jwt.signAsync({ purpose: 'signup', email: 'reena@test.local' }, { expiresIn: '5m' });
      await accept(signup).expect(401);
      await accept(patientToken).expect(401); // a session is not an invitation
      const forPatient = await jwt.signAsync({ purpose: 'receptionist-invite', sub: (await rows<{ id: string }>("SELECT id FROM users WHERE email = 'p1@test.local'"))[0].id }, { expiresIn: '1h' });
      await accept(forPatient).expect(401); // an invitation only ever works for a receptionist
      // A session-style token for the very same pending account (no purpose) must not work as an invitation either.
      await accept(await jwt.signAsync({ sub: created.id, name: 'Reena Reception', role: 'RECEPTIONIST' }, { expiresIn: '1h' })).expect(401);
      await accept(real, 'Brand-New-Pass1').expect(200); // the real one is unaffected
    });

    it('can never be used as a login session', async () => {
      await invite().expect(201);
      await http().get('/api/receptionist/doctors').set(as(lastInviteToken())).expect(401);
      await http().get('/api/auth/me').set(as(lastInviteToken())).expect(401);
    });

    it('can be sent again only while the receptionist has no password', async () => {
      const created = (await invite().expect(201)).body as { id: string };
      await http().post(`/api/admin/receptionists/${created.id}/invitation`).set(as(adminToken)).expect(200);
      expect(sent).toHaveLength(2);
      await accept(lastInviteToken()).expect(200);
      expect((await http().post(`/api/admin/receptionists/${created.id}/invitation`).set(as(adminToken)).expect(409)).body.message).toMatch(/already set a password/i);
      await http().post('/api/admin/receptionists/00000000-0000-4000-8000-000000000000/invitation').set(as(adminToken)).expect(404);
      const patientId = (await rows<{ id: string }>("SELECT id FROM users WHERE email = 'p1@test.local'"))[0].id;
      await http().post(`/api/admin/receptionists/${patientId}/invitation`).set(as(adminToken)).expect(404); // not a receptionist
    });
  });

  describe('clinic access stays with the assignment', () => {
    it('a new receptionist sees only the doctors of their clinic, and moving them moves their access', async () => {
      const created = (await invite().expect(201)).body as { id: string };
      const token = (await accept(lastInviteToken()).expect(200)).body.accessToken as string;
      const names = async () => ((await http().get('/api/receptionist/doctors').set(as(token)).expect(200)).body as { name: string }[]).map((doctor) => doctor.name);
      expect(await names()).toEqual(['Dr. Alpha']);
      const date = addDays(today, 3);
      await db.query("INSERT INTO availability (doctor_id, recurrence_type, specific_date, start_time, end_time, scheduling_mode, capacity_per_slot, slot_duration_minutes) VALUES ($1,'ONE_TIME',$3,'09:00','10:00','STREAM',1,30), ($2,'ONE_TIME',$3,'09:00','10:00','STREAM',1,30)", [doctorA, doctorB, date]);
      const patientId = (await rows<{ id: string }>('SELECT id FROM patients'))[0].id;
      const book = (doctorId: string) => http().post('/api/receptionist/appointments').set(as(token)).send({ patientId, doctorId, date, startTime: '09:00' });
      await book(doctorB).expect(403); // another clinic's doctor
      await book(doctorA).expect(201);

      const moved = await http().put(`/api/admin/receptionists/${created.id}/clinic`).set(as(adminToken)).send({ clinicId: clinicB }).expect(200);
      expect(moved.body).toMatchObject({ clinic: { id: clinicB, name: 'Clinic B' } });
      expect(await rows('SELECT clinic_id FROM receptionist_assignments')).toEqual([{ clinic_id: clinicB }]); // one clinic, never two
      expect(await names()).toEqual(['Dr. Beta']);
      await book(doctorA).expect(403);
      await book(doctorB).expect(201);
      await http().put(`/api/admin/receptionists/${created.id}/clinic`).set(as(adminToken)).send({ clinicId: '00000000-0000-4000-8000-000000000000' }).expect(400);
      await http().put(`/api/admin/receptionists/${created.id}/clinic`).set(as(adminToken)).send({}).expect(400);
      expect(await rows('SELECT clinic_id FROM receptionist_assignments')).toEqual([{ clinic_id: clinicB }]);
    });
  });

  describe('public sign-up', () => {
    it('can still never create a receptionist or an administrator', async () => {
      const signupToken = await jwt.signAsync({ purpose: 'signup', email: 'sneaky@test.local' }, { expiresIn: '5m' });
      for (const role of ['RECEPTIONIST', 'ADMIN']) {
        await http().post('/api/auth/complete-profile').set(as(signupToken)).send({ role, firstName: 'Sneaky', lastName: 'Person' }).expect(400);
      }
      expect(await rows("SELECT 1 FROM users WHERE email = 'sneaky@test.local'")).toEqual([]);
    });
  });

  describe('creating the first administrator from the terminal command', () => {
    it('creates an admin who can sign in, and never turns an existing account into one', async () => {
      expect(await createAdminAccount(db, { name: 'Second Admin', email: 'second@test.local', password: 'Another-Long-Pass9' })).toBe('created');
      expect((await login('second@test.local', 'Another-Long-Pass9').expect(200)).body.user.role).toBe('ADMIN');
      expect(await createAdminAccount(db, { name: 'Pat', email: 'P1@test.local', password: 'Another-Long-Pass9' })).toBe('exists');
      expect(await rows("SELECT role FROM users WHERE email = 'p1@test.local'")).toEqual([{ role: 'PATIENT' }]);
      await expect(createAdminAccount(db, { name: 'Weak', email: 'weak@test.local', password: 'short' })).rejects.toThrow(/at least 12/);
      await expect(createAdminAccount(db, { name: 'Bad', email: 'not-an-email', password: 'Another-Long-Pass9' })).rejects.toThrow(/valid email/);
      expect(await rows("SELECT 1 FROM users WHERE email IN ('weak@test.local', 'not-an-email')")).toEqual([]);
      await db.query("DELETE FROM users WHERE email = 'second@test.local'");
    });
  });
});
