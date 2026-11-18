import { describe, expect, it, vi } from 'vitest';
import { REMOVE_CONFIRM_TEXT, bulkSummary, canRemoveFromHistory, removableCancelled, removeMany } from './past-history';
import type { PatientAppointment, PaymentSummary } from './types';

const payment = (patch: Partial<PaymentSummary>): PaymentSummary => ({ id: 'p', displayStatus: 'PAID', amountPaise: 50_000, paidAt: null, receiptNumber: 'pay_1', orderId: 'o', failureReason: null, refundedPaise: 0, refunds: [], ...patch });
const booking = (status: PatientAppointment['status'], paid: PaymentSummary | null = null) => ({ status, payment: paid });

describe('canRemoveFromHistory: when the button is offered', () => {
  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'] as const)('offers it on a %s booking with no payment', (status) => {
    expect(canRemoveFromHistory(booking(status))).toBe(true);
  });

  it.each(['CONFIRMED', 'PENDING'] as const)('never on an active (%s) booking', (status) => {
    expect(canRemoveFromHistory(booking(status))).toBe(false);
  });

  it('offers it when the money is settled: paid and finished, refunded, partly refunded, abandoned or failed', () => {
    for (const displayStatus of ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED', 'PAYMENT_FAILED'] as const) {
      expect(canRemoveFromHistory(booking('CANCELLED', payment({ displayStatus })))).toBe(true);
    }
  });

  it('does not offer it while a payment is pending or a refund is on its way', () => {
    expect(canRemoveFromHistory(booking('CANCELLED', payment({ displayStatus: 'PAYMENT_PENDING' })))).toBe(false);
    expect(canRemoveFromHistory(booking('CANCELLED', payment({ displayStatus: 'REFUND_PENDING' })))).toBe(false);
  });

  it('does not offer it when a refund failed', () => {
    const failed = payment({ displayStatus: 'PAID', refunds: [{ id: 'r', amountPaise: 50_000, status: 'FAILED', reason: 'x', reference: null, createdAt: '', processedAt: null }] });
    expect(canRemoveFromHistory(booking('CANCELLED', failed))).toBe(false);
  });
});

describe('removableCancelled: what "Remove all cancelled" would try', () => {
  it('lists only cancelled bookings whose money is settled', () => {
    expect(
      removableCancelled([
        { id: 'a', ...booking('CANCELLED') },
        { id: 'b', ...booking('COMPLETED') },
        { id: 'c', ...booking('CANCELLED', payment({ displayStatus: 'REFUND_PENDING' })) },
        { id: 'd', ...booking('CANCELLED', payment({ displayStatus: 'REFUNDED' })) },
        { id: 'e', ...booking('CONFIRMED') },
      ]),
    ).toEqual(['a', 'd']);
  });
});

describe('removeMany: the bulk flow', () => {
  it('removes in order and carries on past one the server refuses, saying why', async () => {
    const hide = vi.fn(async (id: string) => {
      if (id === 'b') throw new Error('A refund for this booking is still being processed.');
    });
    const result = await removeMany(['a', 'b', 'c'], hide, (error) => (error as Error).message);
    expect(hide.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c']);
    expect(result).toEqual({ removed: ['a', 'c'], skipped: [{ id: 'b', reason: 'A refund for this booking is still being processed.' }] });
  });

  it('does nothing for an empty list', async () => {
    const hide = vi.fn();
    expect(await removeMany([], hide, String)).toEqual({ removed: [], skipped: [] });
    expect(hide).not.toHaveBeenCalled();
  });

  it('skips every one when all are refused, without throwing', async () => {
    const result = await removeMany(['a', 'b'], async () => Promise.reject(new Error('nope')), (error) => (error as Error).message);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toHaveLength(2);
  });
});

describe('bulkSummary and the confirm text', () => {
  it('says what was removed', () => {
    expect(bulkSummary({ removed: ['a'], skipped: [] })).toBe('Removed 1 cancelled booking from your history.');
    expect(bulkSummary({ removed: ['a', 'b'], skipped: [] })).toBe('Removed 2 cancelled bookings from your history.');
    expect(bulkSummary({ removed: [], skipped: [] })).toBe('Nothing was removed.');
  });

  it('says how many were skipped and why, once per reason', () => {
    const text = bulkSummary({ removed: ['a'], skipped: [{ id: 'b', reason: 'Refund pending.' }, { id: 'c', reason: 'Refund pending.' }] });
    expect(text).toBe('Removed 1 cancelled booking. 2 could not be removed: Refund pending.');
  });

  it('tells the person that only their list changes and receipts stay in Payments', () => {
    expect(REMOVE_CONFIRM_TEXT).toBe('This only removes it from your list. Receipts stay available in Payments.');
  });
});
