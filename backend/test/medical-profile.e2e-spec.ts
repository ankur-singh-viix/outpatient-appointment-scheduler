// Patient medical profile: own-profile updates, history, role locks, strict body, concurrent writes.
// Uses TEST_DATABASE_URL only (never the development database).

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

describe('Patient medical profile (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let patientUserId: string;
  let patientId: string;
  let tokens: { patient: string; otherPatient: string; doctor: string; reception: string };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const historyCount = async () =>
    Number((await db.query('SELECT count(*)::int AS n FROM patient_medical_profile_history WHERE patient_id = $1', [patientId])).rows[0].n);
  const historyRows = async () =>
    (
      await db.query<{ field_name: string; previous_value: string | null; new_value: string | null }>(
        `SELECT field_name, previous_value, new_value
           FROM patient_medical_profile_history
          WHERE patient_id = $1
          ORDER BY updated_at ASC, field_name ASC`,
        [patientId],
      )
    ).rows;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);

    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;

    patientUserId = await user('Pat Medical', 'pat.med@test.local', 'PATIENT');
    patientId = (await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [patientUserId, '+91911110001'])).rows[0].id as string;
    await user('Other Patient', 'other.med@test.local', 'PATIENT');
    await db.query('INSERT INTO patients (user_id, phone) VALUES ((SELECT id FROM users WHERE email = $1), $2)', ['other.med@test.local', '+91911110001']);

    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('GP') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic Med', '1 Med St') RETURNING id")).rows[0].id as string;
    const doctorUserId = await user('Dr. Med', 'dr.med@test.local', 'DOCTOR');
    await db.query(
      `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
       VALUES ($1, $2, $3, 15, 20, 500)`,
      [doctorUserId, clinicId, specialtyId],
    );
    const receptionUserId = await user('Rita Med', 'rec.med@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2)', [receptionUserId, clinicId]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    tokens = {
      patient: await login('pat.med@test.local'),
      otherPatient: await login('other.med@test.local'),
      doctor: await login('dr.med@test.local'),
      reception: await login('rec.med@test.local'),
    };
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM patient_medical_profile_history WHERE patient_id = $1', [patientId]);
    await db.query(
      `UPDATE patients
          SET blood_group = NULL, allergies = NULL, sensitivities = NULL, medical_conditions = NULL,
              current_medications = NULL, previous_surgeries = NULL, other_medical_info = NULL
        WHERE id = $1`,
      [patientId],
    );
  });

  it('lets a patient update their own medical profile and writes history for changed fields', async () => {
    const before = await historyCount();
    const updated = (
      await http()
        .put('/api/auth/me/profile/medical')
        .set(as(tokens.patient))
        .send({ bloodGroup: 'A+', allergies: 'Penicillin', sensitivities: 'Latex' })
        .expect(200)
    ).body;

    expect(updated).toMatchObject({
      patientId,
      bloodGroup: 'A+',
      allergies: 'Penicillin',
      sensitivities: 'Latex',
    });
    expect(updated.uhid).toMatch(/^CC-UHID-\d{6,}$/);
    expect(await historyCount()).toBe(before + 3);
    expect(await historyRows()).toEqual(
      expect.arrayContaining([
        { field_name: 'bloodGroup', previous_value: null, new_value: 'A+' },
        { field_name: 'allergies', previous_value: null, new_value: 'Penicillin' },
        { field_name: 'sensitivities', previous_value: null, new_value: 'Latex' },
      ]),
    );

    const again = (
      await http().put('/api/auth/me/profile/medical').set(as(tokens.patient)).send({ allergies: 'Peanuts' }).expect(200)
    ).body;
    expect(again.allergies).toBe('Peanuts');
    expect(again.bloodGroup).toBe('A+');
    expect(await historyRows()).toEqual(
      expect.arrayContaining([{ field_name: 'allergies', previous_value: 'Penicillin', new_value: 'Peanuts' }]),
    );
  });

  it('refuses doctors and receptionists (403) and ignores another patient identity in the body', async () => {
    const before = await historyCount();
    await http().put('/api/auth/me/profile/medical').set(as(tokens.doctor)).send({ allergies: 'X' }).expect(403);
    await http().put('/api/auth/me/profile/medical').set(as(tokens.reception)).send({ allergies: 'X' }).expect(403);
    await http().get('/api/auth/me/profile').set(as(tokens.doctor)).expect(403);
    await http().get('/api/auth/me/profile').set(as(tokens.reception)).expect(403);

    // Strict body: patientId / foreign keys are not accepted as a way to target someone else.
    await http()
      .put('/api/auth/me/profile/medical')
      .set(as(tokens.patient))
      .send({ allergies: 'Dust', patientId: '00000000-0000-4000-8000-000000000099' })
      .expect(400);
    await http()
      .put('/api/auth/me/profile/medical')
      .set(as(tokens.otherPatient))
      .send({ allergies: 'Should not touch primary patient' })
      .expect(200);

    expect(await historyCount()).toBe(before);
    expect((await db.query('SELECT allergies FROM patients WHERE id = $1', [patientId])).rows[0].allergies).toBeNull();
  });

  it('rejects unexpected fields and invalid medical values without writing history', async () => {
    const before = await historyCount();
    await http().put('/api/auth/me/profile/medical').set(as(tokens.patient)).send({ allergies: 'Ok', extra: 'nope' }).expect(400);
    await http().put('/api/auth/me/profile/medical').set(as(tokens.patient)).send({ bloodGroup: 'Z+' }).expect(400);
    await http().put('/api/auth/me/profile/medical').set(as(tokens.patient)).send({ allergies: 'x'.repeat(2001) }).expect(400);
    await http().put('/api/auth/me/profile/medical').set(as(tokens.patient)).send({}).expect(400);
    expect(await historyCount()).toBe(before);
  });

  it('serializes concurrent updates so both field changes and history are preserved', async () => {
    const [a, b] = await Promise.all([
      http().put('/api/auth/me/profile/medical').set(as(tokens.patient)).send({ allergies: 'Concurrent A' }),
      http().put('/api/auth/me/profile/medical').set(as(tokens.patient)).send({ bloodGroup: 'O-' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);

    const profile = (await http().get('/api/auth/me/profile').set(as(tokens.patient)).expect(200)).body;
    expect(profile.allergies).toBe('Concurrent A');
    expect(profile.bloodGroup).toBe('O-');

    const rows = await historyRows();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_name: 'allergies', new_value: 'Concurrent A' }),
        expect.objectContaining({ field_name: 'bloodGroup', new_value: 'O-' }),
      ]),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('does not expose medical columns through receptionist patient search', async () => {
    await db.query('UPDATE patients SET allergies = $1, blood_group = $2 WHERE id = $3', ['Secret Allergy', 'B+', patientId]);
    const found = (await http().get('/api/receptionist/patients').query({ search: 'Pat Medical' }).set(as(tokens.reception)).expect(200)).body as Record<
      string,
      unknown
    >[];
    expect(found).toEqual([expect.objectContaining({ id: patientId, name: 'Pat Medical', email: 'pat.med@test.local', phone: '+91911110001' })]);
    expect(JSON.stringify(found)).not.toMatch(/Secret Allergy|bloodGroup|allergies|medicalConditions/i);
  });
});
