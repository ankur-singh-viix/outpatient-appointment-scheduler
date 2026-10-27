import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';
import { Availability } from './availability.entity.js';
import { Clinic } from './clinic.entity.js';
import { Specialty } from './specialty.entity.js';
import { User } from './user.entity.js';

@Entity('doctors')
@Unique('uq_doctors_user', ['userId'])
export class Doctor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column({ name: 'clinic_id', type: 'uuid' })
  clinicId: string;

  @ManyToOne(() => Clinic, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'clinic_id' })
  clinic: Relation<Clinic>;

  @Column({ name: 'specialty_id', type: 'uuid' })
  specialtyId: string;

  @ManyToOne(() => Specialty, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'specialty_id' })
  specialty: Relation<Specialty>;

  @Column({ name: 'consultation_minutes', type: 'integer', default: 15 })
  consultationMinutes: number;

  @Column({ name: 'default_daily_capacity', type: 'integer', default: 20 })
  defaultDailyCapacity: number;

  /** Whole rupees. */
  @Column({ name: 'consultation_fee', type: 'integer', default: 0 })
  consultationFee: number;

  @Column({ type: 'text', nullable: true })
  bio: string | null;

  @OneToMany(() => Availability, (availability) => availability.doctor)
  availability: Relation<Availability[]>;
}
