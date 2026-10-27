import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { Doctor } from './doctor.entity.js';
import { Patient } from './patient.entity.js';
import { User } from './user.entity.js';

export const APPOINTMENT_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that occupy a slot; cancelled, completed and no-show appointments don't. */
export const ACTIVE_STATUSES: AppointmentStatus[] = ['PENDING', 'CONFIRMED'];

@Entity('appointments')
@Index('ix_appointments_patient', ['patientId', 'appointmentDate'])
// Double-booking backstop: one active appointment per doctor per start time.
@Index('uq_active_doctor_appointment_start', ['doctorId', 'appointmentDate', 'startTime'], {
  unique: true,
  where: "status IN ('PENDING', 'CONFIRMED')",
})
export class Appointment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId: string;

  @ManyToOne(() => Patient, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'patient_id' })
  patient: Relation<Patient>;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @ManyToOne(() => Doctor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'doctor_id' })
  doctor: Relation<Doctor>;

  /** The patient, or an authorised receptionist, who made the booking. */
  @Column({ name: 'booked_by_user_id', type: 'uuid' })
  bookedByUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booked_by_user_id' })
  bookedBy: Relation<User>;

  @Column({ name: 'appointment_date', type: 'date' })
  appointmentDate: string;

  @Column({ name: 'start_time', type: 'time' })
  startTime: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime: string;

  @Column({ type: 'enum', enum: [...APPOINTMENT_STATUSES], enumName: 'appointment_status', default: 'CONFIRMED' })
  status: AppointmentStatus;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
