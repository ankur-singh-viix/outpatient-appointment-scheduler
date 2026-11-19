// Medical reports MVP: patient upload/list/download, receptionist scoped upload, doctor list/download.
// Uses TEST_DATABASE_URL + mocked ReportStorage (no real S3).

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
import { MemoryReportStorage, ReportStorage } from '../src/medical-reports/storage.js';

loadEnvFileIfPresent();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the e2e tests (see backend/.env.example).');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.BACKGROUND_JOBS = 'false';
// Enable reports storage config without a real bucket; the storage provider is mocked.
process.env.REPORTS_S3_ENDPOINT = 'https://example.invalid';
process.env.REPORTS_S3_BUCKET = 'care-slot-test';
process.env.REPORTS_S3_ACCESS_KEY_ID = 'test-key';
process.env.REPORTS_S3_SECRET_ACCESS_KEY = 'test-secret';
process.env.REPORTS_S3_REGION = 'auto';

const PASSWORD = 'Test@1234';
const pdfBuffer = Buffer.from('%PDF-1.4 e2e-report');
const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe('Medical reports (e2e)', () => {
  let app: INestApplication<App>;
  let db: pg.Client;
  let memory: MemoryReportStorage;
  let doctorId: string;
  let otherDoctorId: string;
  let patientId: string;
  let otherPatientId: string;
  let patientUserId: string;
  let tokens: { doctor: string; otherDoctor: string; reception: string; patient: string; otherPatient: string };

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
    const specialtyId = (await db.query("INSERT INTO specialties (name) VALUES ('General') RETURNING id")).rows[0].id as string;
    const clinicId = (await db.query("INSERT INTO clinics (name, address) VALUES ('Clinic R', '1 Report St') RETURNING id")).rows[0].id as string;
    const makeDoctor = async (name: string, email: string) =>
      (
        await db.query(
          `INSERT INTO doctors (user_id, clinic_id, specialty_id, consultation_minutes, default_daily_capacity, consultation_fee)
           VALUES ($1, $2, $3, 30, 20, 500) RETURNING id`,
          [await user(name, email, 'DOCTOR'), clinicId, specialtyId],
        )
      ).rows[0].id as string;

    doctorId = await makeDoctor('Dr. Reports', 'rx-reports-doc@test.local');
    otherDoctorId = await makeDoctor('Dr. Other', 'rx-reports-doc2@test.local');
    const reception = await user('Rita Reports', 'rx-reports-rec@test.local', 'RECEPTIONIST');
    await db.query('INSERT INTO receptionist_assignments (receptionist_user_id, clinic_id) VALUES ($1, $2)', [reception, clinicId]);
    await db.query('INSERT INTO doctor_receptionist_assignments (doctor_id, receptionist_user_id) VALUES ($1, $2)', [doctorId, reception]);

    patientUserId = await user('Pat Reports', 'rx-reports-pat@test.local', 'PATIENT');
    patientId = (await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [patientUserId, '+91911110001'])).rows[0].id as string;
    const otherUser = await user('Other Pat', 'rx-reports-pat2@test.local', 'PATIENT');
    otherPatientId = (await db.query('INSERT INTO patients (user_id, phone) VALUES ($1, $2) RETURNING id', [otherUser, '+91911110002'])).rows[0].id as string;

    await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity)
       VALUES ($1, $2, $3, '2026-05-01', '09:00', '09:30', 'CONFIRMED', 1, 1)`,
      [patientId, doctorId, patientUserId],
    );
    // Other patient only has an appointment with the other doctor (not assigned to reception).
    await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, booked_by_user_id, appointment_date, start_time, end_time, status, slot_number, slot_capacity, cancelled_at, cancelled_by_user_id, cancel_reason)
       VALUES ($1, $2, $3, '2026-05-02', '10:00', '10:30', 'CANCELLED', 1, 1, now(), $3, 'test')`,
      [otherPatientId, otherDoctorId, otherUser],
    );

    memory = new MemoryReportStorage();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async () => undefined })
      .overrideProvider(ReportStorage)
      .useValue(memory)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    tokens = {
      doctor: await login('rx-reports-doc@test.local'),
      otherDoctor: await login('rx-reports-doc2@test.local'),
      reception: await login('rx-reports-rec@test.local'),
      patient: await login('rx-reports-pat@test.local'),
      otherPatient: await login('rx-reports-pat2@test.local'),
    };
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('lets a patient upload, list and download their own reports; isolates other patients', async () => {
    const created = (
      await http()
        .post('/api/medical-reports/mine')
        .set(as(tokens.patient))
        .field('category', 'BLOOD_TESTS')
        .field('reportDate', '2026-04-01')
        .attach('file', pdfBuffer, { filename: 'cbc.pdf', contentType: 'application/pdf' })
        .expect(201)
    ).body;
    expect(created).toMatchObject({
      category: 'BLOOD_TESTS',
      reportDate: '2026-04-01',
      originalFilename: 'cbc.pdf',
      uploadedByRole: 'PATIENT',
      patientId,
    });
    expect(created.patientUhid).toMatch(/^CC-UHID-/);
    expect(memory.objects.size).toBeGreaterThan(0);

    const list = (await http().get('/api/medical-reports/mine').set(as(tokens.patient)).expect(200)).body as { id: string }[];
    expect(list.map((row) => row.id)).toContain(created.id);

    const download = (await http().get(`/api/medical-reports/mine/${created.id}/download`).set(as(tokens.patient)).expect(200)).body;
    expect(download.url).toMatch(/^memory:\/\//);
    expect(download.filename).toBe('cbc.pdf');
    expect(JSON.stringify(download)).not.toMatch(/password|secret|accessKey/i);

    await http().get(`/api/medical-reports/mine/${created.id}/download`).set(as(tokens.otherPatient)).expect(404);
    await http().get('/api/medical-reports/doctor/patients/' + patientId).set(as(tokens.patient)).expect(403);
  });

  it('rejects invalid file types for patient upload', async () => {
    await http()
      .post('/api/medical-reports/mine')
      .set(as(tokens.patient))
      .field('category', 'OTHER')
      .field('reportDate', '2026-04-02')
      .attach('file', Buffer.from('not-a-real-image'), { filename: 'notes.txt', contentType: 'text/plain' })
      .expect(400);
  });

  it('lets a receptionist upload only for in-scope patients and never download', async () => {
    const ok = (
      await http()
        .post('/api/medical-reports/reception')
        .set(as(tokens.reception))
        .field('patientId', patientId)
        .field('category', 'X_RAY')
        .field('reportDate', '2026-03-15')
        .attach('file', pngBuffer, { filename: 'chest.png', contentType: 'image/png' })
        .expect(201)
    ).body;
    expect(ok.uploadedByRole).toBe('RECEPTIONIST');

    await http()
      .post('/api/medical-reports/reception')
      .set(as(tokens.reception))
      .field('patientId', otherPatientId)
      .field('category', 'OTHER')
      .field('reportDate', '2026-03-16')
      .attach('file', pngBuffer, { filename: 'out.png', contentType: 'image/png' })
      .expect(404);

    await http().get(`/api/medical-reports/mine/${ok.id}/download`).set(as(tokens.reception)).expect(403);
    await http().get(`/api/medical-reports/doctor/${ok.id}/download`).set(as(tokens.reception)).expect(403);
    await http().get(`/api/medical-reports/doctor/patients/${patientId}`).set(as(tokens.reception)).expect(403);
  });

  it('lets an authorized doctor list and download reports regardless of appointment status', async () => {
    const list = (await http().get(`/api/medical-reports/doctor/patients/${patientId}`).set(as(tokens.doctor)).expect(200)).body as {
      id: string;
      uploadedByRole: string;
    }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((row) => row.uploadedByRole === 'PATIENT')).toBe(true);
    expect(list.some((row) => row.uploadedByRole === 'RECEPTIONIST')).toBe(true);

    const download = (await http().get(`/api/medical-reports/doctor/${list[0].id}/download`).set(as(tokens.doctor)).expect(200)).body;
    expect(download.url).toMatch(/^memory:\/\//);

    await http().get(`/api/medical-reports/doctor/patients/${patientId}`).set(as(tokens.otherDoctor)).expect(404);
    await http().get(`/api/medical-reports/doctor/patients/${otherPatientId}`).set(as(tokens.doctor)).expect(404);
  });
});
