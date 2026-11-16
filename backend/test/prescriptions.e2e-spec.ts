// Doctor creates and finalizes prescriptions; receptionist views and cannot edit finalized ones.

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
import { clinicNow } from '../src/scheduling/calendar.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.BACKGROUND_JOBS = 'false';

const PASSWORD = 'Test@1234';
const today = clinicNow(process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata').date;

describe('Prescriptions (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let doctorId: string;
  let otherDoctorId: string;
  let patientId: string;
  let patientUserId: string;
  let appointmentId: string;
  let otherApptId: string;
  let tokens: { doctor: string; otherDoctor: string; reception: string; patient: string };

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
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic One', '1 A St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string) =>
      (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
           VALUES ($1, $2, $3, 30, 20, 500) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId],
        )
      ).rows[0].id as string;

    doctorId = await makeDoctor('Dr. Alpha', 'rx-doc@test.local');
    otherDoctorId = await makeDoctor('Dr. Beta', 'rx-doc2@test.local');
    const receptionist = await user('Rita Reception', 'rx-rec@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2)', [receptionist, clinicId]);
    await db.query('INSERT INTO doctor_receptionist_assignments (doctor_id, receptionist_user_id) VALUES ($1, $2)', [doctorId, receptionist]);
    patientUserId = await user('Priya Patel', 'rx-pat@test.local', 'PATIENT');
    patientId = (await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [patientUserId, '+91900009999'])).rows[0].id as string;

    const book = async (doctor: string) =>
      (
        await db.query(
          `INSERT INTO appointments (patient_id, doctor_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity, booked_by_user_id)
           VALUES ($1, $2, $3, '10:00', '10:30', 'COMPLETED', 1, 1, $4) RETURNING id`,
          [patientId, doctor, today, patientUserId],
        )
      ).rows[0].id as string;
    appointmentId = await book(doctorId);
    otherApptId = await book(otherDoctorId);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EMAIL_SENDER).useValue({ send: async () => undefined }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    tokens = {
      doctor: await login('rx-doc@test.local'),
      otherDoctor: await login('rx-doc2@test.local'),
      reception: await login('rx-rec@test.local'),
      patient: await login('rx-pat@test.local'),
    };
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('creates a draft, updates it, finalizes it, and refuses further edits', async () => {
    const created = (
      await http()
        .post('/api/prescriptions/doctor')
        .set(as(tokens.doctor))
        .send({ appointmentId, diagnosis: 'Allergic rhinitis', medications: [{ name: 'Cetirizine', dosage: '10mg', frequency: 'once daily', duration: '7 days' }] })
        .expect(201)
    ).body;
    expect(created.status).toBe('DRAFT');
    expect(created.medications[0].name).toBe('Cetirizine');

    await http()
      .put(`/api/prescriptions/doctor/${created.id}`)
      .set(as(tokens.doctor))
      .send({ diagnosis: 'Allergic rhinitis', notes: 'Take after food', medications: [{ name: 'Cetirizine', dosage: '10mg', frequency: 'once daily', duration: '5 days' }] })
      .expect(200);

    const finalized = (await http().post(`/api/prescriptions/doctor/${created.id}/finalize`).set(as(tokens.doctor)).send({}).expect(200)).body;
    expect(finalized.status).toBe('FINALIZED');
    expect(finalized.finalizedAt).toBeTruthy();

    await http()
      .put(`/api/prescriptions/doctor/${created.id}`)
      .set(as(tokens.doctor))
      .send({ medications: [{ name: 'Changed' }] })
      .expect(409);
    await http().post(`/api/prescriptions/doctor/${created.id}/finalize`).set(as(tokens.doctor)).send({}).expect(409);
    await http()
      .post('/api/prescriptions/doctor')
      .set(as(tokens.doctor))
      .send({ appointmentId, medications: [{ name: 'Duplicate' }] })
      .expect(409);
  });

  it('lets the assigned receptionist view finalized prescriptions but not drafts or other doctors', async () => {
    const list = (await http().get('/api/prescriptions/reception').set(as(tokens.reception)).expect(200)).body as { id: string; status: string }[];
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('FINALIZED');

    const detail = (await http().get(`/api/prescriptions/reception/${list[0].id}`).set(as(tokens.reception)).expect(200)).body;
    expect(detail.patient.name).toBe('Priya Patel');
    expect(detail.doctor.name).toBe('Dr. Alpha');
    expect(detail.medications[0].name).toBe('Cetirizine');

    // Receptionist has no write routes.
    await http().post('/api/prescriptions/doctor').set(as(tokens.reception)).send({ appointmentId, medications: [{ name: 'X' }] }).expect(403);
    await http().put(`/api/prescriptions/doctor/${list[0].id}`).set(as(tokens.reception)).send({ medications: [{ name: 'X' }] }).expect(403);

    // Other doctor's prescription is invisible even if finalized later.
    const other = (
      await http()
        .post('/api/prescriptions/doctor')
        .set(as(tokens.otherDoctor))
        .send({ appointmentId: otherApptId, medications: [{ name: 'Ibuprofen' }] })
        .expect(201)
    ).body;
    await http().post(`/api/prescriptions/doctor/${other.id}/finalize`).set(as(tokens.otherDoctor)).send({}).expect(200);
    expect((await http().get('/api/prescriptions/reception').set(as(tokens.reception)).expect(200)).body).toHaveLength(1);
    await http().get(`/api/prescriptions/reception/${other.id}`).set(as(tokens.reception)).expect(404);
  });

  it('refuses a prescription before the consultation is completed, and blocks patients', async () => {
    const pending = (
      await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity, booked_by_user_id)
         VALUES ($1, $2, $3, '11:00', '11:30', 'CONFIRMED', 1, 1, $4) RETURNING id`,
        [patientId, doctorId, today, patientUserId],
      )
    ).rows[0].id as string;
    await http()
      .post('/api/prescriptions/doctor')
      .set(as(tokens.doctor))
      .send({ appointmentId: pending, medications: [{ name: 'Too soon' }] })
      .expect(409);
    await http().get('/api/prescriptions/doctor').set(as(tokens.patient)).expect(403);
  });
});
