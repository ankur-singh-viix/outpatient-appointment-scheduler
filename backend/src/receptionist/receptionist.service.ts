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
    const builder = this.appointments
      .createQueryBuilder('appointment')
      .innerJoinAndSelect('appointment.doctor', 'doctor')
      .innerJoinAndSelect('doctor.user', 'doctorUser')
      .innerJoinAndSelect('appointment.patient', 'patient')
      .innerJoinAndSelect('patient.user', 'patientUser')
      .where('appointment.doctorId IN (:...doctorIds)', { doctorIds })
      .andWhere('appointment.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .andWhere(query.date ? 'appointment.appointmentDate = :date' : 'appointment.appointmentDate >= :date', { date: query.date ?? today })
      .orderBy('appointment.appointmentDate', 'ASC')
      .addOrderBy('appointment.startTime', 'ASC')
      .addOrderBy('appointment.slotNumber', 'ASC')
      .take(200);
    if (query.doctorId) {
      if (!doctorIds.includes(query.doctorId)) return [];
      builder.andWhere('appointment.doctorId = :doctorId', { doctorId: query.doctorId });
    }
    const rows = await builder.getMany();
    return rows.map((row) => ({
      id: row.id,
      date: row.appointmentDate,
      startTime: hhmm(row.startTime),
      endTime: hhmm(row.endTime),
      status: row.status,
      slotNumber: row.slotNumber,
      slotCapacity: row.slotCapacity,
      patient: { id: row.patient.id, name: row.patient.user.name, phone: row.patient.phone },
      doctor: { id: row.doctor.id, name: row.doctor.user.name },
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
