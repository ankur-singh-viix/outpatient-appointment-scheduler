import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, Unique, type Relation } from 'typeorm';
import { User } from './user.entity.js';

@Entity('patients')
@Unique('uq_patients_user', ['userId'])
@Unique('uq_patients_uhid', ['uhid'])
export class Patient {
  /** Permanent patient identity (UUID). Reused for all appointments and check-ins. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Owning CareSlot account. Currently one patient profile per account (unique).
   * Future family profiles can add a separate authorization link table without changing this id/UHID.
   */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  /** Human-readable permanent ID (CC-UHID-000001). Issued once when the patient row is created. */
  @Column({ type: 'varchar', length: 32 })
  uhid: string;

  /** Not unique: Indian families often share one phone. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  gender: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ name: 'blood_group', type: 'varchar', length: 8, nullable: true })
  bloodGroup: string | null;

  @Column({ type: 'text', nullable: true })
  allergies: string | null;

  @Column({ type: 'text', nullable: true })
  sensitivities: string | null;

  @Column({ name: 'medical_conditions', type: 'text', nullable: true })
  medicalConditions: string | null;

  @Column({ name: 'current_medications', type: 'text', nullable: true })
  currentMedications: string | null;

  @Column({ name: 'previous_surgeries', type: 'text', nullable: true })
  previousSurgeries: string | null;

  @Column({ name: 'other_medical_info', type: 'text', nullable: true })
  otherMedicalInfo: string | null;
}
