// Doctor assigns, changes or removes a receptionist; the receptionist then only reaches that doctor's appointments.

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

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';

describe('Doctor receptionist assignment (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorA: string;
  let doctorB: string;
  let receptionistA: string;
  let receptionistB: string;
  let tokens: { doctorA: string; doctorB: string; receptionA: string; receptionB: string };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);

    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicA = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic A', '1 A St') RETURNING id")).rows[0].id as string;
    const clinicB = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic B', '2 B St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string, clinicId: string) =>
      (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
           VALUES ($1, $2, $3, 30, 20, 500) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId],
        )
      ).rows[0].id as string;

    doctorA = await makeDoctor('Dr. Alpha', 'dr-a@test.local', clinicA);
    doctorB = await makeDoctor('Dr. Beta', 'dr-b@test.local', clinicB);
    receptionistA = await user('Rita A', 'rec-a@test.local', 'RECEPTIONIST');
    receptionistB = await user('Rita B', 'rec-b@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2), ($3, $4)', [receptionistA, clinicA, receptionistB, clinicB]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => undefined }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    tokens = {
      doctorA: await login('dr-a@test.local'),
      doctorB: await login('dr-b@test.local'),
      receptionA: await login('rec-a@test.local'),
      receptionB: await login('rec-b@test.local'),
    };
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('lists clinic candidates and starts with no assignment', async () => {
    expect((await http().get('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).expect(200)).body).toBeNull();
    const candidates = (await http().get('/api/doctor-portal/receptionist/candidates').set(as(tokens.doctorA)).expect(200)).body as { id: string; name: string }[];
    expect(candidates.map((row) => row.id)).toEqual([receptionistA]);
    expect((await http().get('/api/receptionist/doctors').set(as(tokens.receptionA)).expect(200)).body).toEqual([]);
  });

  it('assigns, changes and removes a receptionist; scope follows at once', async () => {
    const assigned = (await http().put('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).send({ receptionistUserId: receptionistA }).expect(200)).body;
    expect(assigned).toMatchObject({ id: receptionistA, name: 'Rita A' });
    expect((await http().get('/api/receptionist/doctors').set(as(tokens.receptionA)).expect(200)).body.map((d: { id: string }) => d.id)).toEqual([doctorA]);

    await http().put('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).send({ receptionistUserId: receptionistB }).expect(400); // other clinic via id
    await http().put('/api/doctor-portal/receptionist').set(as(tokens.doctorB)).send({ receptionistUserId: receptionistB }).expect(200);
    expect((await http().get('/api/receptionist/doctors').set(as(tokens.receptionB)).expect(200)).body.map((d: { id: string }) => d.id)).toEqual([doctorB]);

    await http().delete('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).expect(200);
    expect((await http().get('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).expect(200)).body).toBeNull();
    expect((await http().get('/api/receptionist/doctors').set(as(tokens.receptionA)).expect(200)).body).toEqual([]);
    await http().delete('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).expect(404);
  });

  it('assigns a self-registered receptionist by email and refuses non-receptionist accounts', async () => {
    const hash = await hashPassword(PASSWORD);
    const selfRegistered = (
      await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [
        'Self Desk',
        'self-desk@test.local',
        hash,
        'RECEPTIONIST',
      ])
    ).rows[0].id as string;
    const patientId = (
      await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [
        'Pat Patient',
        'pat-desk@test.local',
        hash,
        'PATIENT',
      ])
    ).rows[0].id as string;
    void patientId;

    await http().put('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).send({ email: 'missing@test.local' }).expect(404);
    await http().put('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).send({ email: 'pat-desk@test.local' }).expect(400);

    const assigned = (
      await http().put('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).send({ email: 'Self-Desk@test.local' }).expect(200)
    ).body;
    expect(assigned).toMatchObject({ id: selfRegistered, name: 'Self Desk', email: 'self-desk@test.local' });
    expect((await http().get('/api/doctor-portal/receptionist').set(as(tokens.doctorA)).expect(200)).body).toMatchObject({
      id: selfRegistered,
      email: 'self-desk@test.local',
    });
    const selfToken = await login('self-desk@test.local');
    expect((await http().get('/api/receptionist/doctors').set(as(selfToken)).expect(200)).body.map((d: { id: string }) => d.id)).toEqual([
      doctorA,
    ]);
    const clinicLinks = (await db.query('SELECT clinic_id FROM receptionist_assignments WHERE receptionist_user_id = $1', [selfRegistered])).rows;
    expect(clinicLinks).toHaveLength(1);
  });

  it('refuses receptionist routes to other roles', async () => {
    await http().get('/api/doctor-portal/receptionist').set(as(tokens.receptionA)).expect(403);
    await http().put('/api/doctor-portal/receptionist').set(as(tokens.receptionA)).send({ receptionistUserId: receptionistA }).expect(403);
  });
});
