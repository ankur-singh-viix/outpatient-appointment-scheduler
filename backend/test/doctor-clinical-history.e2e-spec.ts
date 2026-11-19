// Doctor clinical history: authorized medical profile + visits; isolation; ordering; empty states.
// Uses TEST_DATABASE_URL only.

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

describe('Doctor clinical history (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorA: string;
  let doctorB: string;
  let patientShared: string;
  let patientOnlyB: string;
  let patientEmpty: string;
  let tokens: { doctorA: string; doctorB: string; reception: string; patient: string };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string) => (await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken as string;
  const history = (token: string, patientId: string) => http().get(`/api/doctor-portal/patients/${patientId}/clinical-history`).set(as(token));

  beforeAll(async () => {
    db = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await db.connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(TEST_DATABASE_URL!);

    const hash = await hashPassword(PASSWORD);
    const user = async (name: string, email: string, role: string) =>
      (await db.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hash, role])).rows[0].id as string;
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('ENT') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic H', '1 Hist St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string) =>
      (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
           VALUES ($1, $2, $3, 30, 20, 500) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId],
        )
      ).rows[0].id as string;
    const makePatient = async (name: string, email: string, allergies: string | null = null) => {
      const userId = await user(name, email, 'PATIENT');
      return (
        await db.query('INSERT INTO patients (user_id, phone, allergies, blood_group) VALUES ($1, $2, $3, $4) RETURNING id', [
          userId,
          '+91988880001',
          allergies,
          allergies ? 'A+' : null,
        ])
      ).rows[0].id as string;
    };

    doctorA = await makeDoctor('Dr. Hist A', 'dr-hist-a@test.local');
    doctorB = await makeDoctor('Dr. Hist B', 'dr-hist-b@test.local');
    patientShared = await makePatient('Shared Patient', 'shared.hist@test.local', 'Penicillin');
    patientOnlyB = await makePatient('Only B Patient', 'onlyb.hist@test.local', 'Dust');
    patientEmpty = await makePatient('Empty History', 'empty.hist@test.local');

    const doctorAUser = (await db.query("SELECT user_id FROM doctors WHERE id = $1", [doctorA])).rows[0].user_id as string;
    await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity)
       VALUES
         ($1, $2, $3, '2026-01-10', '09:00', '09:30', 'COMPLETED', 1, 1),
         ($1, $2, $3, '2026-02-10', '10:00', '10:30', 'CONFIRMED', 1, 1)`,
      [patientShared, doctorA, doctorAUser],
    );
    const olderAppt = (
      await db.query(
        `SELECT id FROM appointments WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = '2026-01-10'`,
        [patientShared, doctorA],
      )
    ).rows[0].id as string;
    await db.query(
      `INSERT INTO prescriptions (appointment_id, doctor_id, patient_id, status, diagnosis, notes, medications, created_by_user_id, finalized_at, finalized_by_user_id)
       VALUES ($1, $2, $3, 'FINALIZED', 'Otitis', 'Rest and fluids', $4::jsonb, $5, now(), $5)`,
      [olderAppt, doctorA, patientShared, JSON.stringify([{ name: 'Amoxicillin', dosage: '500mg' }]), doctorAUser],
    );

    const doctorBUser = (await db.query('SELECT user_id FROM doctors WHERE id = $1', [doctorB])).rows[0].user_id as string;
    await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity)
       VALUES ($1, $2, $3, '2026-03-01', '11:00', '11:30', 'CONFIRMED', 1, 1)`,
      [patientOnlyB, doctorB, doctorBUser],
    );

    // One shared appointment for empty patient so doctor A is authorized but history has no visits? Wait - if they have appointment it shows in visits.
    // empty patient: authorize via a cancelled appointment so medical can be empty and visits list has one cancelled row — or authorize with appointment and expect visits length 1.
    // Spec wants empty history responses: use patient with appointment but no medical + no finalized Rx; visits may still list the appointment.
    await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity)
       VALUES ($1, $2, $3, '2026-04-01', '12:00', '12:30', 'CONFIRMED', 1, 1)`,
      [patientEmpty, doctorA, doctorAUser],
    );

    const patientUserId = (await db.query('SELECT user_id FROM patients WHERE id = $1', [patientShared])).rows[0].user_id as string;
    await db.query(
      `INSERT INTO patient_medical_profile_history (patient_id, field_name, previous_value, new_value, updated_by_user_id)
       VALUES ($1, 'allergies', NULL, 'Penicillin', $2)`,
      [patientShared, patientUserId],
    );

    const reception = await user('Rita Hist', 'rec.hist@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2)', [reception, clinicId]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    tokens = {
      doctorA: await login('dr-hist-a@test.local'),
      doctorB: await login('dr-hist-b@test.local'),
      reception: await login('rec.hist@test.local'),
      patient: await login('shared.hist@test.local'),
    };
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('lets an authorized doctor read medical profile, updates, visits newest-first, and finalized prescriptions', async () => {
    const body = (await history(tokens.doctorA, patientShared).expect(200)).body;
    expect(body.patient).toMatchObject({ id: patientShared, name: 'Shared Patient' });
    expect(body.patient.uhid).toMatch(/^CC-UHID-\d{6,}$/);
    expect(body.medicalProfile).toMatchObject({ bloodGroup: 'A+', allergies: 'Penicillin' });
    expect(body.medicalUpdates[0]).toMatchObject({
      fieldName: 'allergies',
      newValue: 'Penicillin',
      updatedBy: { name: 'Shared Patient', role: 'PATIENT' },
    });
    expect(body.visits.map((v: { date: string }) => v.date)).toEqual(['2026-02-10', '2026-01-10']);
    expect(body.visits[1].prescription).toMatchObject({
      status: 'FINALIZED',
      diagnosis: 'Otitis',
      notes: 'Rest and fluids',
      medications: [expect.objectContaining({ name: 'Amoxicillin' })],
    });
    expect(body.visits[0].prescription).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/password|password_hash/i);
  });

  it('refuses unauthorized doctors, patients and receptionists; unknown patients look missing', async () => {
    await history(tokens.doctorA, patientOnlyB).expect(404);
    await history(tokens.doctorB, patientShared).expect(404);
    await history(tokens.patient, patientShared).expect(403);
    await history(tokens.reception, patientShared).expect(403);
    await history(tokens.doctorA, '00000000-0000-4000-8000-000000000099').expect(404);
  });

  it('returns empty medical details and no prescription when none exist', async () => {
    const body = (await history(tokens.doctorA, patientEmpty).expect(200)).body;
    expect(body.medicalProfile).toMatchObject({
      bloodGroup: null,
      allergies: null,
      sensitivities: null,
      medicalConditions: null,
      currentMedications: null,
      previousSurgeries: null,
      otherMedicalInfo: null,
    });
    expect(body.medicalUpdates).toEqual([]);
    expect(body.visits).toHaveLength(1);
    expect(body.visits[0].prescription).toBeNull();
  });
});
