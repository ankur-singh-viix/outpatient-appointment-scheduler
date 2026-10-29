import type { Payment } from '../database/entities/index.js';
import { displayStatusOf, toPaymentSummary } from './payment-summary.js';

const refund = (status: 'PENDING' | 'PROCESSED' | 'FAILED', amountPaise: number) => ({ status, amountPaise });

describe('displayStatusOf', () => {
  const paid = { status: 'PAID' as const, amountPaise: 65000 };

  it('describes a payment that is not paid yet', () => {
    expect(displayStatusOf({ status: 'CREATED', amountPaise: 1 }, [])).toBe('PAYMENT_PENDING');
    expect(displayStatusOf({ status: 'FAILED', amountPaise: 1 }, [])).toBe('PAYMENT_FAILED');
    expect(displayStatusOf({ status: 'EXPIRED', amountPaise: 1 }, [])).toBe('EXPIRED');
  });

  it('is PAID with no refunds, or only failed ones', () => {
    expect(displayStatusOf(paid, [])).toBe('PAID');
    expect(displayStatusOf(paid, [refund('FAILED', 65000)])).toBe('PAID');
  });

  it('only calls money "refunded" once a refund is confirmed (a pending one is not done yet)', () => {
    expect(displayStatusOf(paid, [refund('PENDING', 65000)])).toBe('REFUND_PENDING');
    expect(displayStatusOf(paid, [refund('PROCESSED', 65000)])).toBe('REFUNDED');
  });

  it('is PARTIALLY_REFUNDED when some, but not all, is confirmed back', () => {
    expect(displayStatusOf(paid, [refund('PROCESSED', 32500)])).toBe('PARTIALLY_REFUNDED');
    expect(displayStatusOf(paid, [refund('PROCESSED', 32500), refund('PENDING', 32500)])).toBe('PARTIALLY_REFUNDED');
    expect(displayStatusOf(paid, [refund('PROCESSED', 32500), refund('PROCESSED', 32500)])).toBe('REFUNDED');
  });
});

describe('toPaymentSummary', () => {
  it('exposes the receipt number, refund references and only confirmed refunded money', () => {
    const payment = {
      id: 'p1',
      status: 'PAID',
      amountPaise: 65000,
      currency: 'INR',
      paidAt: new Date('2026-11-01T00:00:00Z'),
      razorpayPaymentId: 'pay_abc',
      razorpayOrderId: 'order_abc',
      failureReason: null,
      refunds: [
        { id: 'r2', amountPaise: 1000, status: 'PENDING', reason: 'b', razorpayRefundId: null, createdAt: new Date('2026-11-02T00:00:00Z'), processedAt: null },
        { id: 'r1', amountPaise: 5000, status: 'PROCESSED', reason: 'a', razorpayRefundId: 'rfnd_1', createdAt: new Date('2026-11-01T12:00:00Z'), processedAt: new Date('2026-11-01T13:00:00Z') },
      ],
    } as unknown as Payment;
    const summary = toPaymentSummary(payment);
    expect(summary).toMatchObject({ receiptNumber: 'pay_abc', orderId: 'order_abc', refundedPaise: 5000, displayStatus: 'PARTIALLY_REFUNDED' });
    expect(summary.refunds.map((entry) => entry.id)).toEqual(['r1', 'r2']); // oldest first
    expect(summary.refunds[0].reference).toBe('rfnd_1');
    expect(summary.refunds[1].reference).toBeNull();
    expect(Object.keys(summary)).not.toContain('razorpayPaymentId'); // internal column names never leak
  });
});
