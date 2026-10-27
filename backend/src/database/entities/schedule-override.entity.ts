import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, type Relation } from 'typeorm';
import { Doctor } from './doctor.entity.js';

/** A one-off exception for a specific date: a day off, or different hours. */
@Entity('schedule_overrides')
@Unique('uq_override_doctor_date', ['doctorId', 'overrideDate'])
export class ScheduleOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @ManyToOne(() => Doctor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doctor_id' })
  doctor: Relation<Doctor>;

  /** Calendar date as "YYYY-MM-DD". */
  @Column({ name: 'override_date', type: 'date' })
  overrideDate: string;

  @Column({ name: 'is_available', type: 'boolean' })
  isAvailable: boolean;

  @Column({ name: 'start_time', type: 'time', nullable: true })
  startTime: string | null;

  @Column({ name: 'end_time', type: 'time', nullable: true })
  endTime: string | null;

  @Column({ type: 'integer', nullable: true })
  capacity: number | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;
}
