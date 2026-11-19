import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Patient } from './patient.entity.js';
import { User } from './user.entity.js';

/** One field change on a patient's medical profile. Rows are append-only. */
@Entity('patient_medical_profile_history')
export class PatientMedicalProfileHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId: string;

  @ManyToOne(() => Patient, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'patient_id' })
  patient: Relation<Patient>;

  /** Camel-case field name matching the API (e.g. bloodGroup, allergies). */
  @Column({ name: 'field_name', type: 'varchar', length: 64 })
  fieldName: string;

  @Column({ name: 'previous_value', type: 'text', nullable: true })
  previousValue: string | null;

  @Column({ name: 'new_value', type: 'text', nullable: true })
  newValue: string | null;

  @Column({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'updated_by_user_id' })
  updatedBy: Relation<User>;

  @CreateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
