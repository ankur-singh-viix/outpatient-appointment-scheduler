import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** One conversation a doctor or patient had with the assistant. Always read and written through the signed-in user. See migration 013. */
@Entity('assistant_conversations')
export class AssistantConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 10 })
  role: 'DOCTOR' | 'PATIENT';

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** One message of a conversation: text and the names of the lookups used. Never a confirmation token or an action payload. */
@Entity('assistant_messages')
export class AssistantMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  /** Written by the database (an identity column) so messages keep the order they were saved in. */
  @Column({ type: 'bigint', insert: false, update: false })
  seq: string;

  @Column({ type: 'varchar', length: 10 })
  role: 'user' | 'assistant';

  @Column({ type: 'text' })
  text: string;

  @Column({ name: 'tool_names', type: 'text', array: true, default: () => "'{}'" })
  toolNames: string[];

  /** The reply came with a confirmation card. The card is not kept: history shows "Card expired". */
  @Column({ name: 'had_card', type: 'boolean', default: false })
  hadCard: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
