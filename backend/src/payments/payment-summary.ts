import type { Payment } from '../database/entities/index.js';

export type PaymentDisplayStatus =
  | 'PAYMENT_PENDING'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'PAID'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export interface RefundSummary {
  id: string;
  amountPaise: number;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  reason: string;
  /** Razorpay's refund id: what to quote to the bank or to support. Null until Razorpay has accepted the refund. */
  reference: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface PaymentSummary {
  id: string;
  status: Payment['status'];
  displayStatus: PaymentDisplayStatus;
  amountPaise: number;
  currency: string;
  paidAt: Date | null;
  /** The Razorpay payment id doubles as the receipt number. Null until paid. */
  receiptNumber: string | null;
  orderId: string;
  failureReason: string | null;
  /** Money Razorpay has confirmed returning. Pending refunds are not counted: they are not done yet. */
  refundedPaise: number;
  refunds: RefundSummary[];
}

/** What the patient should see for a payment, derived from the payment and its refunds. A refund counts only once confirmed. */
export function displayStatusOf(payment: Pick<Payment, 'status' | 'amountPaise'>, refunds: Pick<RefundSummary, 'status' | 'amountPaise'>[]): PaymentDisplayStatus {
  if (payment.status === 'CREATED') return 'PAYMENT_PENDING';
  if (payment.status === 'FAILED') return 'PAYMENT_FAILED';
  if (payment.status === 'EXPIRED') return 'EXPIRED';
  const sum = (status: RefundSummary['status']) => refunds.filter((refund) => refund.status === status).reduce((total, refund) => total + refund.amountPaise, 0);
  const processed = sum('PROCESSED');
  if (processed >= payment.amountPaise) return 'REFUNDED';
  if (processed > 0) return 'PARTIALLY_REFUNDED';
  if (sum('PENDING') > 0) return 'REFUND_PENDING';
  return 'PAID';
}

export function toPaymentSummary(payment: Payment): PaymentSummary {
  const refunds: RefundSummary[] = [...(payment.refunds ?? [])]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((refund) => ({
      id: refund.id,
      amountPaise: refund.amountPaise,
      status: refund.status,
      reason: refund.reason,
      reference: refund.razorpayRefundId,
      createdAt: refund.createdAt,
      processedAt: refund.processedAt,
    }));
  return {
    id: payment.id,
    status: payment.status,
    displayStatus: displayStatusOf(payment, refunds),
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    paidAt: payment.paidAt,
    receiptNumber: payment.razorpayPaymentId,
    orderId: payment.razorpayOrderId,
    failureReason: payment.failureReason,
    refundedPaise: refunds.filter((refund) => refund.status === 'PROCESSED').reduce((total, refund) => total + refund.amountPaise, 0),
    refunds,
  };
}
