import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, Unique, type Relation } from 'typeorm';
import { User } from './user.entity.js';

@Entity('patients')
@Unique('uq_patients_user', ['userId'])
export class Patient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  gender: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;
}
