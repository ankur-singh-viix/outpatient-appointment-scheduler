import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Doctor } from './doctor.entity.js';

export type RecurrenceType = 'WEEKLY' | 'ONE_TIME';
export type SchedulingMode = 'STREAM' | 'WAVE';

/**
 * A working window, either repeating weekly (day_of_week: 0 = Sunday ... 6 = Saturday) or on one date. It is cut into slots of
 * slot_duration_minutes, each taking capacity_per_slot patients (always 1 for STREAM). See docs/scheduling.md.
 */
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

  @Column({ name: 'recurrence_type', type: 'enum', enum: ['WEEKLY', 'ONE_TIME'], enumName: 'recurrence_type', default: 'WEEKLY' })
  recurrenceType: RecurrenceType;

  /** WEEKLY rows only. */
  @Column({ name: 'day_of_week', type: 'smallint', nullable: true })
  dayOfWeek: number | null;

  /** ONE_TIME rows only, as "YYYY-MM-DD". */
  @Column({ name: 'specific_date', type: 'date', nullable: true })
  specificDate: string | null;

  /** Clinic-local time as "HH:MM:SS". */
  @Column({ name: 'start_time', type: 'time' })
  startTime: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime: string;

  /** STREAM: the most bookings the whole session takes (null: the doctor's default). Not used by WAVE, which limits each slot. */
  @Column({ type: 'integer', nullable: true })
  capacity: number | null;

  /** Slot length; null means the doctor's consultation length. */
  @Column({ name: 'slot_duration_minutes', type: 'integer', nullable: true })
  slotDurationMinutes: number | null;

  /** Patients one slot takes. Always 1 for STREAM. */
  @Column({ name: 'capacity_per_slot', type: 'integer', default: 1 })
  capacityPerSlot: number;

  @Column({ name: 'effective_from', type: 'date', nullable: true })
  effectiveFrom: string | null;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo: string | null;

  @Column({
    name: 'scheduling_mode',
    type: 'enum',
    enum: ['STREAM', 'WAVE'],
    enumName: 'scheduling_mode',
    default: 'STREAM',
  })
  schedulingMode: SchedulingMode;
}
