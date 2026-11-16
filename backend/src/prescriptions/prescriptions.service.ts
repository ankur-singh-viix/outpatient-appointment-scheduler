import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import {
  Appointment,
  Doctor,
  DoctorReceptionistAssignment,
  Prescription,
  type PrescriptionMedication,
} from '../database/entities/index.js';
import { clinicNow } from '../scheduling/calendar.js';
import { hhmm } from '../scheduling/slots.js';

/** True when a query failed because the prescriptions table does not exist (migration 016 not applied). */
export function isMissingPrescriptionTable(error: unknown): boolean {
  const e = (error as { code?: unknown; driverError?: { code?: unknown } } | null) ?? {};
  return e.code === '42P01' || e.driverError?.code === '42P01';
}

const conflict = (code: string, message: string) => new ConflictException({ statusCode: 409, error: 'Conflict', code, message });

export interface PrescriptionInput {
  diagnosis?: string | null;
  notes?: string | null;
  medications: PrescriptionMedication[];
}

/**
 * Prescriptions: the doctor drafts and finalizes; the receptionist may only view and print finalized ones for doctors who
 * assigned them. One prescription per appointment.
 */
@Injectable()
export class PrescriptionsService {
  private readonly config = loadConfig();

  constructor(private readonly dataSource: DataSource) {}

  // ---- Doctor ----

  async listForDoctor(user: AuthUser, query: { date?: string; status?: 'DRAFT' | 'FINALIZED' }) {
    return this.guard(async () => {
      const doctor = await this.doctorOf(user);
      const params: unknown[] = [doctor.id];
      let sql = `
        SELECT p.id, p.appointment_id, p.status, p.diagnosis, p.notes, p.medications, p.finalized_at, p.created_at, p.updated_at,
               a.appointment_date::text AS appointment_date, a.start_time::text AS start_time, a.end_time::text AS end_time, a.status::text AS appointment_status,
               pu.name AS patient_name
          FROM prescriptions p
          JOIN appointments a ON a.id = p.appointment_id
          JOIN patients pt ON pt.id = p.patient_id JOIN users pu ON pu.id = pt.user_id
         WHERE p.doctor_id = $1`;
      if (query.status) {
        params.push(query.status);
        sql += ` AND p.status = $${params.length}`;
      }
      if (query.date) {
        params.push(query.date);
        sql += ` AND a.appointment_date = $${params.length}::date`;
      }
      sql += ' ORDER BY a.appointment_date DESC, a.start_time DESC, p.created_at DESC LIMIT 100';
      const rows: Record<string, unknown>[] = await this.dataSource.query(sql, params);
      return rows.map((row) => this.summary(row));
    });
  }

  async getForDoctor(user: AuthUser, id: string) {
    return this.guard(async () => {
      const doctor = await this.doctorOf(user);
      return this.describe(await this.loadOwned(doctor.id, id));
    });
  }

  /** Creates a draft for a COMPLETED appointment of this doctor. One prescription per appointment. */
  async create(user: AuthUser, appointmentId: string, input: PrescriptionInput) {
    return this.guard(async () => {
      const doctor = await this.doctorOf(user);
      this.assertMedications(input.medications);
      const id = await this.dataSource.transaction(async (manager) => {
        const appointment = await manager.findOne(Appointment, { where: { id: appointmentId, doctorId: doctor.id }, lock: { mode: 'pessimistic_write' } });
        if (!appointment) throw new NotFoundException('Appointment not found.');
        if (appointment.status !== 'COMPLETED') {
          throw conflict('NOT_COMPLETED', 'Write a prescription after the consultation is completed.');
        }
        if (await manager.existsBy(Prescription, { appointmentId })) {
          throw conflict('ALREADY_EXISTS', 'This appointment already has a prescription.');
        }
        const row = await manager.save(
          manager.create(Prescription, {
            appointmentId,
            doctorId: doctor.id,
            patientId: appointment.patientId,
            status: 'DRAFT',
            diagnosis: cleanText(input.diagnosis),
            notes: cleanText(input.notes),
            medications: input.medications,
            createdByUserId: user.id,
          }),
        );
        return row.id;
      });
      return this.describe(await this.loadOwned(doctor.id, id));
    });
  }

  async updateDraft(user: AuthUser, id: string, input: PrescriptionInput) {
    return this.guard(async () => {
      const doctor = await this.doctorOf(user);
      this.assertMedications(input.medications);
      await this.dataSource.transaction(async (manager) => {
        const row = await this.lockOwned(manager, doctor.id, id);
        if (row.status !== 'DRAFT') throw conflict('ALREADY_FINALIZED', 'A finalized prescription cannot be edited.');
        row.diagnosis = cleanText(input.diagnosis);
        row.notes = cleanText(input.notes);
        row.medications = input.medications;
        await manager.save(row);
      });
      return this.describe(await this.loadOwned(doctor.id, id));
    });
  }

  async finalize(user: AuthUser, id: string) {
    return this.guard(async () => {
      const doctor = await this.doctorOf(user);
      await this.dataSource.transaction(async (manager) => {
        const row = await this.lockOwned(manager, doctor.id, id);
        if (row.status === 'FINALIZED') throw conflict('ALREADY_FINALIZED', 'This prescription is already finalized.');
        if (!row.medications.length) throw new BadRequestException('Add at least one medication before finalizing.');
        row.status = 'FINALIZED';
        row.finalizedAt = new Date();
        row.finalizedByUserId = user.id;
        await manager.save(row);
      });
      return this.describe(await this.loadOwned(doctor.id, id));
    });
  }

  // ---- Receptionist (finalized only) ----

  async listForReception(user: AuthUser, query: { date?: string; doctorId?: string }) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      if (doctorIds.length === 0) return [];
      if (query.doctorId && !doctorIds.includes(query.doctorId)) return [];
      const params: unknown[] = [doctorIds];
      let sql = `
        SELECT p.id, p.appointment_id, p.status, p.diagnosis, p.notes, p.medications, p.finalized_at, p.created_at, p.updated_at,
               a.appointment_date::text AS appointment_date, a.start_time::text AS start_time, a.end_time::text AS end_time, a.status::text AS appointment_status,
               pu.name AS patient_name, du.name AS doctor_name, c.name AS clinic_name, c.address AS clinic_address, s.name AS specialty
          FROM prescriptions p
          JOIN appointments a ON a.id = p.appointment_id
          JOIN patients pt ON pt.id = p.patient_id JOIN users pu ON pu.id = pt.user_id
          JOIN doctors d ON d.id = p.doctor_id JOIN users du ON du.id = d.user_id
          JOIN clinics c ON c.id = d.clinic_id JOIN specialties s ON s.id = d.specialty_id
         WHERE p.status = 'FINALIZED' AND p.doctor_id = ANY($1::uuid[])`;
      if (query.doctorId) {
        params.push(query.doctorId);
        sql += ` AND p.doctor_id = $${params.length}`;
      }
      if (query.date) {
        params.push(query.date);
        sql += ` AND a.appointment_date = $${params.length}::date`;
      } else {
        params.push(clinicNow(this.config.clinicTimezone).date);
        sql += ` AND a.appointment_date >= $${params.length}::date`;
      }
      sql += ' ORDER BY a.appointment_date DESC, a.start_time DESC LIMIT 100';
      const rows: Record<string, unknown>[] = await this.dataSource.query(sql, params);
      return rows.map((row) => this.printView(row));
    });
  }

  async getForReception(user: AuthUser, id: string) {
    return this.guard(async () => {
      const doctorIds = await this.assignedDoctorIds(user);
      const rows: Record<string, unknown>[] = await this.dataSource.query(
        `SELECT p.id, p.appointment_id, p.status, p.diagnosis, p.notes, p.medications, p.finalized_at, p.created_at, p.updated_at,
                a.appointment_date::text AS appointment_date, a.start_time::text AS start_time, a.end_time::text AS end_time, a.status::text AS appointment_status,
                pu.name AS patient_name, du.name AS doctor_name, c.name AS clinic_name, c.address AS clinic_address, s.name AS specialty
           FROM prescriptions p
           JOIN appointments a ON a.id = p.appointment_id
           JOIN patients pt ON pt.id = p.patient_id JOIN users pu ON pu.id = pt.user_id
           JOIN doctors d ON d.id = p.doctor_id JOIN users du ON du.id = d.user_id
           JOIN clinics c ON c.id = d.clinic_id JOIN specialties s ON s.id = d.specialty_id
          WHERE p.id = $1 AND p.status = 'FINALIZED' AND p.doctor_id = ANY($2::uuid[])`,
        [id, doctorIds],
      );
      if (!rows[0]) throw new NotFoundException('Prescription not found.');
      return this.printView(rows[0]);
    });
  }

  // ---- internals ----

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isMissingPrescriptionTable(error)) {
        throw new ServiceUnavailableException('Prescriptions are not available yet: the database has not been updated (migration 016).');
      }
      throw error;
    }
  }

  private async doctorOf(user: AuthUser): Promise<{ id: string }> {
    const doctor = await this.dataSource.getRepository(Doctor).findOneBy({ userId: user.id });
    if (!doctor) throw new ForbiddenException('No doctor profile is linked to this account.');
    return { id: doctor.id };
  }

  private async assignedDoctorIds(user: AuthUser): Promise<string[]> {
    const rows = await this.dataSource.getRepository(DoctorReceptionistAssignment).find({ where: { receptionistUserId: user.id } });
    return rows.map((row) => row.doctorId);
  }

  private assertMedications(medications: PrescriptionMedication[]) {
    if (!Array.isArray(medications) || medications.length === 0) {
      throw new BadRequestException('Add at least one medication.');
    }
    for (const med of medications) {
      if (!med.name?.trim()) throw new BadRequestException('Each medication needs a name.');
      if (med.name.trim().length > 120) throw new BadRequestException('Medication name is too long.');
    }
  }

  private async lockOwned(manager: EntityManager, doctorId: string, id: string): Promise<Prescription> {
    const row = await manager.findOne(Prescription, { where: { id, doctorId }, lock: { mode: 'pessimistic_write' } });
    if (!row) throw new NotFoundException('Prescription not found.');
    return row;
  }

  private async loadOwned(doctorId: string, id: string): Promise<Record<string, unknown>> {
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT p.id, p.appointment_id, p.status, p.diagnosis, p.notes, p.medications, p.finalized_at, p.created_at, p.updated_at,
              a.appointment_date::text AS appointment_date, a.start_time::text AS start_time, a.end_time::text AS end_time, a.status::text AS appointment_status,
              pu.name AS patient_name, du.name AS doctor_name, c.name AS clinic_name, c.address AS clinic_address, s.name AS specialty
         FROM prescriptions p
         JOIN appointments a ON a.id = p.appointment_id
         JOIN patients pt ON pt.id = p.patient_id JOIN users pu ON pu.id = pt.user_id
         JOIN doctors d ON d.id = p.doctor_id JOIN users du ON du.id = d.user_id
         JOIN clinics c ON c.id = d.clinic_id JOIN specialties s ON s.id = d.specialty_id
        WHERE p.id = $1 AND p.doctor_id = $2`,
      [id, doctorId],
    );
    if (!rows[0]) throw new NotFoundException('Prescription not found.');
    return rows[0];
  }

  private summary(row: Record<string, unknown>) {
    return {
      id: row.id as string,
      appointmentId: row.appointment_id as string,
      status: row.status as string,
      diagnosis: (row.diagnosis as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      medications: (row.medications as PrescriptionMedication[]) ?? [],
      patient: { name: row.patient_name as string },
      appointment: {
        date: row.appointment_date as string,
        startTime: hhmm(row.start_time as string),
        endTime: hhmm(row.end_time as string),
        status: row.appointment_status as string,
      },
      finalizedAt: row.finalized_at ? new Date(row.finalized_at as string).toISOString() : null,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    };
  }

  private describe(row: Record<string, unknown>) {
    return {
      ...this.summary(row),
      doctor: {
        name: row.doctor_name as string,
        specialty: row.specialty as string,
        clinic: { name: row.clinic_name as string, address: row.clinic_address as string },
      },
    };
  }

  private printView(row: Record<string, unknown>) {
    return this.describe(row);
  }
}

function cleanText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
