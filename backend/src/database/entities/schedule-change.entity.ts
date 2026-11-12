import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/** One applied change of an availability row's hours. The audit trail of "who changed the hours, from when, to what". See migration 011. */
@Entity('schedule_changes')
export class ScheduleChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @Column({ name: 'availability_id', type: 'uuid', nullable: true })
  availabilityId: string | null;

  @Column({ type: 'varchar', length: 10 })
  kind: 'EXPAND' | 'SHRINK' | 'MIXED';

  @Column({ name: 'apply_from', type: 'date' })
  applyFrom: string;

  @Column({ name: 'old_start_time', type: 'time' })
  oldStartTime: string;

  @Column({ name: 'old_end_time', type: 'time' })
  oldEndTime: string;

  @Column({ name: 'new_start_time', type: 'time' })
  newStartTime: string;

  @Column({ name: 'new_end_time', type: 'time' })
  newEndTime: string;

  @Column({ name: 'affected_count', type: 'integer', default: 0 })
  affectedCount: number;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

export const SCHEDULE_RESOLUTIONS = ['RESCHEDULED', 'CANCELLED', 'COVERED', 'CLOSED'] as const;
export type ScheduleResolution = (typeof SCHEDULE_RESOLUTIONS)[number];

/** An appointment a reduction left outside the hours, followed until somebody settles it. The appointment keeps its own status. */
@Entity('schedule_change_appointments')
export class ScheduleChangeAppointment {
  @PrimaryColumn({ name: 'change_id', type: 'uuid' })
  changeId: string;

  @PrimaryColumn({ name: 'appointment_id', type: 'uuid' })
  appointmentId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Set by the background notifier once the patient has been asked (or was already asked within the last day). */
  @Column({ name: 'notified_at', type: 'timestamptz', nullable: true })
  notifiedAt: Date | null;

  @Column({ name: 'proposed_date', type: 'date', nullable: true })
  proposedDate: string | null;

  @Column({ name: 'proposed_start_time', type: 'time', nullable: true })
  proposedStartTime: string | null;

  @Column({ name: 'proposed_end_time', type: 'time', nullable: true })
  proposedEndTime: string | null;

  @Column({ type: 'smallint', default: 0 })
  attempts: number;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'varchar', length: 12, nullable: true })
  resolution: ScheduleResolution | null;
}
