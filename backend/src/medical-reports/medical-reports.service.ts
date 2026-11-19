import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import {
  DoctorReceptionistAssignment,
  MEDICAL_REPORT_CATEGORIES,
  Patient,
  PatientMedicalReport,
  type MedicalReportCategory,
  type MedicalReportUploaderRole,
} from '../database/entities/index.js';
import { dateSchema } from '../scheduling/schemas.js';
import { MEDICAL_REPORT_MAX_BYTES, validateReportFile } from './file-validation.js';
import { ReportStorage } from './storage.js';

export interface UploadedFileInput {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Injectable()
export class MedicalReportsService {
  private readonly config = loadConfig();

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: ReportStorage,
  ) {}

  async uploadForPatient(user: AuthUser, file: UploadedFileInput, input: { category: string; reportDate: string }) {
    this.assertStorageReady();
    const patient = await this.patientOf(user);
    return this.saveReport({
      patient,
      file,
      category: this.parseCategory(input.category),
      reportDate: this.parseReportDate(input.reportDate),
      uploadedByUserId: user.id,
      uploadedByRole: 'PATIENT',
    });
  }

  async uploadForReception(user: AuthUser, file: UploadedFileInput, input: { patientId: string; category: string; reportDate: string }) {
    this.assertStorageReady();
    await this.assertReceptionistMayUpload(user, input.patientId);
    const patient = await this.dataSource.getRepository(Patient).findOneBy({ id: input.patientId });
    if (!patient) throw new NotFoundException('Patient not found.');
    return this.saveReport({
      patient,
      file,
      category: this.parseCategory(input.category),
      reportDate: this.parseReportDate(input.reportDate),
      uploadedByUserId: user.id,
      uploadedByRole: 'RECEPTIONIST',
    });
  }

  async listMine(user: AuthUser) {
    const patient = await this.patientOf(user);
    const rows = await this.dataSource.getRepository(PatientMedicalReport).find({
      where: { patientId: patient.id },
      order: { reportDate: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
    return rows.map((row) => this.describe(row));
  }

  async downloadMine(user: AuthUser, id: string) {
    this.assertStorageReady();
    const patient = await this.patientOf(user);
    const row = await this.dataSource.getRepository(PatientMedicalReport).findOneBy({ id, patientId: patient.id });
    if (!row) throw new NotFoundException('Report not found.');
    return this.signedDownload(row);
  }

  async listForDoctor(user: AuthUser, patientId: string) {
    await this.assertDoctorMayAccessPatient(user, patientId);
    const rows = await this.dataSource.getRepository(PatientMedicalReport).find({
      where: { patientId },
      order: { reportDate: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
    return rows.map((row) => this.describe(row));
  }

  async downloadForDoctor(user: AuthUser, id: string) {
    this.assertStorageReady();
    const row = await this.dataSource.getRepository(PatientMedicalReport).findOneBy({ id });
    if (!row) throw new NotFoundException('Report not found.');
    await this.assertDoctorMayAccessPatient(user, row.patientId);
    return this.signedDownload(row);
  }

  private async saveReport(input: {
    patient: Patient;
    file: UploadedFileInput;
    category: MedicalReportCategory;
    reportDate: string;
    uploadedByUserId: string;
    uploadedByRole: MedicalReportUploaderRole;
  }) {
    if (!input.patient.uhid) throw new BadRequestException('Patient UHID is missing. Complete patient registration first.');
    const maxBytes = Math.min(this.config.reportsStorage.maxBytes || MEDICAL_REPORT_MAX_BYTES, MEDICAL_REPORT_MAX_BYTES);
    if (input.file.size > maxBytes) {
      throw new BadRequestException('File is too large. The maximum size is 10 MB.');
    }
    const validated = validateReportFile(input.file);

    // Assign id + final storage key up front so a failed PutObject never leaves a pending/* row.
    const id = randomUUID();
    const storageKey = `patients/${input.patient.id}/reports/${id}/${validated.originalFilename}`;
    const repo = this.dataSource.getRepository(PatientMedicalReport);
    const saved = await repo.save(
      repo.create({
        id,
        patientId: input.patient.id,
        patientUhid: input.patient.uhid,
        category: input.category,
        reportDate: input.reportDate,
        originalFilename: validated.originalFilename,
        contentType: validated.contentType,
        byteSize: validated.byteSize,
        storageKey,
        uploadedByUserId: input.uploadedByUserId,
        uploadedByRole: input.uploadedByRole,
      }),
    );
    try {
      await this.storage.putObject({ key: storageKey, body: validated.buffer, contentType: validated.contentType });
    } catch {
      try {
        await repo.delete({ id: saved.id });
      } catch {
        // Prefer the storage failure as the client-facing error; row cleanup is best-effort.
      }
      throw new ServiceUnavailableException('Could not store the report file. Try again later.');
    }
    return this.describe(saved);
  }

  private async signedDownload(row: PatientMedicalReport) {
    const expiresSeconds = this.config.reportsStorage.downloadTtlSeconds;
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();
    let url: string;
    try {
      url = await this.storage.getSignedDownloadUrl({
        key: row.storageKey,
        contentType: row.contentType,
        filename: row.originalFilename,
        expiresSeconds,
      });
    } catch {
      throw new ServiceUnavailableException('Could not prepare a download link. Try again later.');
    }
    return {
      url,
      expiresAt,
      contentType: row.contentType,
      filename: row.originalFilename,
    };
  }

  private describe(row: PatientMedicalReport) {
    return {
      id: row.id,
      patientId: row.patientId,
      patientUhid: row.patientUhid,
      category: row.category,
      reportDate: row.reportDate,
      originalFilename: row.originalFilename,
      contentType: row.contentType,
      byteSize: row.byteSize,
      uploadedByRole: row.uploadedByRole,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private assertStorageReady() {
    if (!this.config.reportsStorage.enabled) {
      throw new ServiceUnavailableException('Medical report storage is not configured.');
    }
  }

  private async patientOf(user: AuthUser): Promise<Patient> {
    const patient = await this.dataSource.getRepository(Patient).findOneBy({ userId: user.id });
    if (!patient) throw new ForbiddenException('No patient profile is linked to this account.');
    return patient;
  }

  private async assertDoctorMayAccessPatient(user: AuthUser, patientId: string) {
    const rows: { ok: number }[] = await this.dataSource.query(
      `SELECT 1 AS ok
         FROM doctors d
         JOIN appointments a ON a.doctor_id = d.id AND a.patient_id = $2
        WHERE d.user_id = $1
        LIMIT 1`,
      [user.id, patientId],
    );
    if (!rows[0]) throw new NotFoundException('Patient not found.');
  }

  /** Receptionist may upload only when the patient has an appointment with a doctor assigned to them. */
  private async assertReceptionistMayUpload(user: AuthUser, patientId: string) {
    const doctorIds = (
      await this.dataSource.getRepository(DoctorReceptionistAssignment).find({ where: { receptionistUserId: user.id } })
    ).map((row) => row.doctorId);
    if (doctorIds.length === 0) throw new ForbiddenException('No doctors are assigned to this receptionist account.');

    const rows: { ok: number }[] = await this.dataSource.query(
      `SELECT 1 AS ok
         FROM appointments a
        WHERE a.patient_id = $1 AND a.doctor_id = ANY($2::uuid[])
        LIMIT 1`,
      [patientId, doctorIds],
    );
    if (!rows[0]) throw new NotFoundException('Patient not found.');
  }

  private parseCategory(value: string): MedicalReportCategory {
    if ((MEDICAL_REPORT_CATEGORIES as readonly string[]).includes(value)) return value as MedicalReportCategory;
    throw new BadRequestException('category: choose a valid report category.');
  }

  private parseReportDate(value: string): string {
    const parsed = dateSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('reportDate: must be in YYYY-MM-DD format.');
    return parsed.data;
  }
}
