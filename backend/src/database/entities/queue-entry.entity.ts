import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const QUEUE_STATUSES = ['BOOKED', 'WAITING', 'SERVING', 'COMPLETED', 'CHECKED_OUT', 'SKIPPED', 'CANCELLED'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const QUEUE_EVENTS = ['BOOKED', 'CHECKED_IN', 'CALLED', 'COMPLETED', 'CHECKED_OUT', 'SKIPPED', 'RETURNED', 'CANCELLED'] as const;
export type QueueEventName = (typeof QUEUE_EVENTS)[number];

/**
 * A place in one doctor's queue for one day. The token is issued when the appointment is confirmed (status BOOKED).
 * Check-in moves it to WAITING without changing the token. See migrations 015 and 017.
 */
@Entity('queue_entries')
export class QueueEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'appointment_id', type: 'uuid' })
  appointmentId: string;

  @Column({ name: 'doctor_id', type: 'uuid' })
  doctorId: string;

  @Column({ name: 'patient_id', type: 'uuid' })
  patientId: string;

  /** The clinic-local day. Tokens restart at 1 each day, for each doctor. */
  @Column({ name: 'queue_date', type: 'date' })
  queueDate: string;

  @Column({ name: 'token_number', type: 'integer' })
  tokenNumber: number;

  @Column({ type: 'varchar', length: 12, default: 'BOOKED' })
  status: QueueStatus;

  /** Null while BOOKED; set when the receptionist checks the patient in. */
  @Column({ name: 'checked_in_at', type: 'timestamptz', nullable: true })
  checkedInAt: Date | null;

  @Column({ name: 'checked_in_by_user_id', type: 'uuid', nullable: true })
  checkedInByUserId: string | null;

  @Column({ name: 'called_at', type: 'timestamptz', nullable: true })
  calledAt: Date | null;

  @Column({ name: 'called_by_user_id', type: 'uuid', nullable: true })
  calledByUserId: string | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'completed_by_user_id', type: 'uuid', nullable: true })
  completedByUserId: string | null;

  @Column({ name: 'checked_out_at', type: 'timestamptz', nullable: true })
  checkedOutAt: Date | null;

  @Column({ name: 'checked_out_by_user_id', type: 'uuid', nullable: true })
  checkedOutByUserId: string | null;

  @Column({ name: 'skipped_at', type: 'timestamptz', nullable: true })
  skippedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** One change of a queue entry: who did what, and when. Append only. */
@Entity('queue_events')
export class QueueEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'entry_id', type: 'uuid' })
  entryId: string;

  @Column({ type: 'varchar', length: 16 })
  event: QueueEventName;

  @Column({ name: 'from_status', type: 'varchar', length: 12, nullable: true })
  fromStatus: QueueStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 12 })
  toStatus: QueueStatus;

  @Column({ name: 'actor_user_id', type: 'uuid' })
  actorUserId: string;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;
}
