import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppointmentsService } from '../appointments/appointments.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { ACTIVE_STATUSES, Appointment, Doctor, DoctorReceptionistAssignment, Patient } from '../database/entities/index.js';
import { clinicNow } from '../scheduling/calendar.js';
import { hhmm } from '../scheduling/slots.js';

/** Treats % and _ in user input as literal characters in ILIKE patterns. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * What a receptionist can do: see the doctors who assigned them, find a registered patient, and book, move or cancel an appointment
 * for that patient with those doctors only. Booking, moving and cancelling are the patient's own code paths in AppointmentsService
 * (same transaction, slot rules, seats and database guards), so a receptionist can never overbook a slot. Every doctor and
 * appointment is checked against the doctor's assignment first.
 */
@Injectable()
export class ReceptionistService {
  private readonly config = loadConfig();

  constructor(
    @InjectRepository(DoctorReceptionistAssignment) private readonly doctorAssignments: Repository<DoctorReceptionistAssignment>,
    @InjectRepository(Doctor) private readonly doctors: Repository<Doctor>,
    @InjectRepository(Patient) private readonly patients: Repository<Patient>,
    @InjectRepository(Appointment) private readonly appointments: Repository<Appointment>,
    private readonly appointmentService: AppointmentsService,
  ) {}

  private async assignedDoctorIds(user: AuthUser): Promise<string[]> {
    const rows = await this.doctorAssignments.find({ where: { receptionistUserId: user.id } });
    return rows.map((row) => row.doctorId);
  }

  /** The doctors who have assigned this receptionist. */
  async listDoctors(user: AuthUser) {
    const doctorIds = await this.assignedDoctorIds(user);
    if (doctorIds.length === 0) return [];
    const rows = await this.doctors.find({
      where: { id: In(doctorIds) },
      relations: { user: true, specialty: true, clinic: true },
      order: { user: { name: 'ASC' } },
    });
    return rows.map((doctor) => ({
      id: doctor.id,
      name: doctor.user.name,
      specialty: doctor.specialty.name,
      clinic: { name: doctor.clinic.name, address: doctor.clinic.address },
      consultationFee: doctor.consultationFee,
      consultationMinutes: doctor.consultationMinutes,
    }));
  }

  /** Registered patients matching a name, email or phone number. A few characters are needed, and only a few results come back. */
  async searchPatients(search: string) {
    const pattern = `%${escapeLike(search.trim())}%`;
    const rows = await this.patients
      .createQueryBuilder('patient')
      .innerJoinAndSelect('patient.user', 'user')
      .where('user.name ILIKE :pattern OR user.email ILIKE :pattern OR patient.phone ILIKE :pattern', { pattern })
      .orderBy('user.name', 'ASC')
      .take(10)
      .getMany();
    return rows.map((patient) => ({ id: patient.id, name: patient.user.name, email: patient.user.email, phone: patient.phone }));
  }

  /** Active appointments for the doctors who assigned this receptionist: on one date, or from today on. */
  async listAppointments(user: AuthUser, query: { date?: string; doctorId?: string }) {
    const doctorIds = await this.assignedDoctorIds(user);
    if (doctorIds.length === 0) return [];
    const today = clinicNow(this.config.clinicTimezone).date;
    const params: unknown[] = [doctorIds, ACTIVE_STATUSES, query.date ?? today];
    let sql = `
      SELECT a.id, a.appointment_date::text AS date, a.start_time::text AS start_time, a.end_time::text AS end_time,
             a.status::text AS status, a.slot_number, a.slot_capacity,
             p.id AS patient_id, pu.name AS patient_name, p.phone AS patient_phone,
             d.id AS doctor_id, du.name AS doctor_name,
             q.token_number
        FROM appointments a
        JOIN doctors d ON d.id = a.doctor_id JOIN users du ON du.id = d.user_id
        JOIN patients p ON p.id = a.patient_id JOIN users pu ON pu.id = p.user_id
        LEFT JOIN queue_entries q ON q.appointment_id = a.id
       WHERE a.doctor_id = ANY($1::uuid[])
         AND a.status::text = ANY($2::text[])
         AND ${query.date ? 'a.appointment_date = $3::date' : 'a.appointment_date >= $3::date'}`;
    if (query.doctorId) {
      if (!doctorIds.includes(query.doctorId)) return [];
      params.push(query.doctorId);
      sql += ` AND a.doctor_id = $${params.length}`;
    }
    sql += ' ORDER BY a.appointment_date ASC, a.start_time ASC, a.slot_number ASC LIMIT 200';
    const rows: Record<string, unknown>[] = await this.appointments.manager.query(sql, params);
    return rows.map((row) => ({
      id: row.id as string,
      date: row.date as string,
      startTime: hhmm(row.start_time as string),
      endTime: hhmm(row.end_time as string),
      status: row.status as string,
      slotNumber: Number(row.slot_number),
      slotCapacity: Number(row.slot_capacity),
      queueToken: row.token_number == null ? null : Number(row.token_number),
      patient: { id: row.patient_id as string, name: row.patient_name as string, phone: (row.patient_phone as string | null) ?? null },
      doctor: { id: row.doctor_id as string, name: row.doctor_name as string },
    }));
  }

  /** Books a registered patient into a slot with one of the doctors who assigned this receptionist. Confirmed at once; fee at clinic. */
  async book(user: AuthUser, input: { patientId: string; doctorId: string; date: string; startTime: string; availabilityId?: string }) {
    await this.assertDoctorAllowed(user, input.doctorId);
    if (!(await this.patients.existsBy({ id: input.patientId }))) throw new NotFoundException('Patient not found.');
    const { patientId, ...slot } = input;
    return this.appointmentService.bookFor(user, patientId, slot, { collectAtClinic: true });
  }

  async cancel(user: AuthUser, id: string, reason?: string) {
    const appointment = await this.appointmentInScope(user, id);
    return this.appointmentService.cancelFor(user, id, appointment.patientId, reason?.trim() || 'Cancelled by reception');
  }

  async reschedule(user: AuthUser, id: string, input: { date: string; startTime: string }) {
    const appointment = await this.appointmentInScope(user, id);
    return this.appointmentService.rescheduleFor(user, id, appointment.patientId, input);
  }

  private async assertDoctorAllowed(user: AuthUser, doctorId: string): Promise<void> {
    if (!(await this.doctors.existsBy({ id: doctorId }))) throw new NotFoundException('Doctor not found.');
    if (!(await this.assignedDoctorIds(user)).includes(doctorId)) {
      throw new ForbiddenException('This doctor has not assigned you as their receptionist.');
    }
  }

  /** The appointment, if its doctor assigned this receptionist; otherwise it looks like a missing one. */
  private async appointmentInScope(user: AuthUser, id: string): Promise<Appointment> {
    const appointment = await this.appointments.findOne({ where: { id }, relations: { doctor: true } });
    if (!appointment || !(await this.assignedDoctorIds(user)).includes(appointment.doctorId)) {
      throw new NotFoundException('Appointment not found.');
    }
    return appointment;
  }
}
