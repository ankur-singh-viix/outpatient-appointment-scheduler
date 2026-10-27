import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { ROLES, type Role } from '../../auth/auth.types.js';

// Entities map onto the tables created by backend/db/migrations (synchronize is off).
@Entity('users')
@Unique('uq_users_email', ['email'])
@Unique('uq_users_google_id', ['googleId'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255, nullable: true })
  passwordHash: string | null;

  @Column({ name: 'google_id', type: 'varchar', length: 255, nullable: true })
  googleId: string | null;

  @Column({ type: 'enum', enum: [...ROLES], enumName: 'user_role' })
  role: Role;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
