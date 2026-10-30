import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A patient's choices about how CareSlot contacts them. A patient with no row has the defaults (see migration 009), so a row is
 * only written once they change something. Essential appointment emails are not a preference: they are always sent.
 */
@Entity('notification_preferences')
export class NotificationPreference {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Also send essential appointment, payment and refund updates by text (the email is sent regardless). */
  @Column({ name: 'sms_enabled', type: 'boolean', default: true })
  smsEnabled: boolean;

  @Column({ name: 'email_reminders', type: 'boolean', default: true })
  emailReminders: boolean;

  @Column({ name: 'sms_reminders', type: 'boolean', default: true })
  smsReminders: boolean;

  @Column({ name: 'promotional_email', type: 'boolean', default: false })
  promotionalEmail: boolean;

  /** When the patient ticked the promotional email box. Always set while it is on. */
  @Column({ name: 'promotional_email_consent_at', type: 'timestamptz', nullable: true })
  promotionalEmailConsentAt: Date | null;

  @Column({ name: 'promotional_sms', type: 'boolean', default: false })
  promotionalSms: boolean;

  @Column({ name: 'promotional_sms_consent_at', type: 'timestamptz', nullable: true })
  promotionalSmsConsentAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
