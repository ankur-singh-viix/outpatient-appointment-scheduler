import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type AssistantActionKind = 'BOOK' | 'RESCHEDULE' | 'CANCEL';
export type AssistantActionStatus = 'PREPARED' | 'CONFIRMING' | 'DONE' | 'FAILED' | 'DISMISSED';

/**
 * Something the assistant prepared for a patient to confirm. The confirmation reference is this row's id; it runs only for `userId`,
 * only once, only before `expiresAt`, and only with the stored `params`. See migration 012.
 */
@Entity('assistant_actions')
export class AssistantAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 12 })
  kind: AssistantActionKind;

  @Column({ type: 'jsonb' })
  params: Record<string, string>;

  @Column({ type: 'varchar', length: 10, default: 'PREPARED' })
  status: AssistantActionStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'result_appointment_id', type: 'uuid', nullable: true })
  resultAppointmentId: string | null;

  @Column({ type: 'text', nullable: true })
  failure: string | null;
}
