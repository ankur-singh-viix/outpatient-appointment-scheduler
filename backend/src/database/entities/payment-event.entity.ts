import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** A Razorpay webhook event id that has been handled, so a redelivery is acknowledged without being applied again. */
@Entity('payment_events')
export class PaymentEvent {
  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 120 })
  eventId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}
