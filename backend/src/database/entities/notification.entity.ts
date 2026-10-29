import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED', 'CANCELLED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** One message waiting to be delivered (or already delivered) on some channel. See migration 006 for how the outbox works. */
@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'appointment_id', type: 'uuid', nullable: true })
  appointmentId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'email' })
  channel: string;

  @Column({ type: 'varchar', length: 40 })
  kind: string;

  @Column({ name: 'to_address', type: 'varchar', length: 255 })
  toAddress: string;

  @Column({ type: 'varchar', length: 200 })
  subject: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'send_at', type: 'timestamptz', default: () => 'now()' })
  sendAt: Date;

  @Column({ type: 'enum', enum: [...NOTIFICATION_STATUSES], enumName: 'notification_status', default: 'PENDING' })
  status: NotificationStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ name: 'dedupe_key', type: 'varchar', length: 160 })
  dedupeKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
