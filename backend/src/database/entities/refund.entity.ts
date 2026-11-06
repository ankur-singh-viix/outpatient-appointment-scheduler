import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Payment } from './payment.entity.js';

export const REFUND_STATUSES = ['PENDING', 'PROCESSED', 'FAILED'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** PROCESSED means Razorpay confirmed the money is being returned; PENDING means we asked and are still waiting. */
@Entity('refunds')
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId: string;

  @ManyToOne(() => Payment, (payment) => payment.refunds, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id' })
  payment: Relation<Payment>;

  @Column({ name: 'amount_paise', type: 'integer' })
  amountPaise: number;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'enum', enum: [...REFUND_STATUSES], enumName: 'refund_status', default: 'PENDING' })
  status: RefundStatus;

  @Column({ name: 'razorpay_refund_id', type: 'varchar', length: 64, nullable: true })
  razorpayRefundId: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 120 })
  idempotencyKey: string;

  /** Null when the cancellation policy refunded automatically. */
  @Column({ name: 'initiated_by_user_id', type: 'uuid', nullable: true })
  initiatedByUserId: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
