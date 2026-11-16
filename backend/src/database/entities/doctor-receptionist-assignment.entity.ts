import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';
import { Doctor } from './doctor.entity.js';
import { User } from './user.entity.js';

/** The receptionist a doctor has chosen for their front desk. One per doctor; changing replaces the row. */
@Entity('doctor_receptionist_assignments')
@Unique('uq_doctor_receptionist_doctor', ['doctorId'])
export class DoctorReceptionistAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @ManyToOne(() => Doctor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doctor_id' })
  doctor: Relation<Doctor>;

  @Column({ name: 'receptionist_user_id', type: 'uuid' })
  receptionistUserId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'receptionist_user_id' })
  receptionist: Relation<User>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
