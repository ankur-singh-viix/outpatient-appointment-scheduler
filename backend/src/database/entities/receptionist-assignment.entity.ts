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
import { Clinic } from './clinic.entity.js';
import { User } from './user.entity.js';

@Entity('receptionist_assignments')
@Unique('uq_receptionist_clinic', ['receptionistUserId', 'clinicId'])
export class ReceptionistAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'receptionist_user_id', type: 'uuid' })
  receptionistUserId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'receptionist_user_id' })
  receptionist: Relation<User>;

  @Column({ name: 'clinic_id', type: 'uuid' })
  clinicId: string;

  @ManyToOne(() => Clinic, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clinic_id' })
  clinic: Relation<Clinic>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
