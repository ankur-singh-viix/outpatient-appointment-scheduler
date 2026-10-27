import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Doctor } from './doctor.entity.js';

/** A doctor's recurring weekly session. day_of_week: 0 = Sunday ... 6 = Saturday. */
@Entity('availability')
@Index('ix_availability_doctor_day', ['doctorId', 'dayOfWeek'])
export class Availability {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @ManyToOne(() => Doctor, (doctor) => doctor.availability, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doctor_id' })
  doctor: Relation<Doctor>;

  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek: number;

  /** Clinic-local time as "HH:MM:SS". */
  @Column({ name: 'start_time', type: 'time' })
  startTime: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime: string;

  @Column({ type: 'integer' })
  capacity: number;

  @Column({
    name: 'scheduling_mode',
    type: 'enum',
    enum: ['STREAM', 'WAVE'],
    enumName: 'scheduling_mode',
    default: 'STREAM',
  })
  schedulingMode: 'STREAM' | 'WAVE';
}
