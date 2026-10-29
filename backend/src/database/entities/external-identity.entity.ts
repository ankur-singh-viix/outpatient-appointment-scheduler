import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, Unique, type Relation } from 'typeorm';
import { User } from './user.entity.js';

/** An outside sign-in (for example Clerk) linked to a CareSlot user. The user keeps their role and data in our tables. */
@Entity('external_identities')
@Unique('uq_external_identities_user_provider', ['userId', 'provider'])
export class ExternalIdentity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  provider: string;

  @PrimaryColumn({ name: 'external_id', type: 'varchar', length: 255 })
  externalId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @CreateDateColumn({ name: 'linked_at', type: 'timestamptz' })
  linkedAt: Date;
}
