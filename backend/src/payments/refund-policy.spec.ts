import type { RefundPolicy } from '../config.js';
import { refundFor } from './refund-policy.js';

const policy: RefundPolicy = { fullRefundHoursBefore: 24, partialRefundHoursBefore: 2, partialRefundPercent: 50 };
const now = new Date('2026-11-01T06:00:00Z');
const startIn = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
const refund = (hours: number, cancelledBy: 'PATIENT' | 'DOCTOR' | 'SYSTEM' = 'PATIENT', paidPaise = 65000, p = policy) =>
  refundFor({ paidPaise, appointmentStart: startIn(hours), now, cancelledBy, policy: p });

describe('refundFor', () => {
  it('refunds in full when the patient cancels with plenty of notice', () => {
    expect(refund(72)).toMatchObject({ amountPaise: 65000, percent: 100 });
    expect(refund(24)).toMatchObject({ amountPaise: 65000, percent: 100 }); // exactly on the boundary counts as enough notice
  });

  it('refunds the configured share when notice is short but not too short', () => {
    expect(refund(23.99)).toMatchObject({ amountPaise: 32500, percent: 50 });
    expect(refund(2)).toMatchObject({ amountPaise: 32500, percent: 50 });
  });

  it('refunds nothing when the appointment is about to start', () => {
    expect(refund(1.99)).toMatchObject({ amountPaise: 0, percent: 0 });
    expect(refund(0.1).reason).toMatch(/no refund/i);
  });

  it('always refunds in full when the clinic cancels, however late', () => {
    expect(refund(0.5, 'DOCTOR')).toMatchObject({ amountPaise: 65000, percent: 100 });
    expect(refund(0.5, 'SYSTEM')).toMatchObject({ amountPaise: 65000, percent: 100 });
    expect(refund(0.5, 'DOCTOR').reason).toMatch(/clinic/i);
  });

  it('rounds a partial refund down to whole paise, so it can never exceed what was paid', () => {
    expect(refund(10, 'PATIENT', 10001).amountPaise).toBe(5000);
    expect(refund(10, 'PATIENT', 1).amountPaise).toBe(0);
  });

  it('follows whatever policy is configured', () => {
    const strict: RefundPolicy = { fullRefundHoursBefore: 48, partialRefundHoursBefore: 12, partialRefundPercent: 25 };
    expect(refund(47, 'PATIENT', 40000, strict)).toMatchObject({ amountPaise: 10000, percent: 25 });
    expect(refund(11, 'PATIENT', 40000, strict).amountPaise).toBe(0);
  });

  it('treats a 0% partial tier as no refund', () => {
    expect(refund(10, 'PATIENT', 65000, { ...policy, partialRefundPercent: 0 }).amountPaise).toBe(0);
  });

  it('explains every outcome in words the patient can read', () => {
    for (const hours of [72, 10, 1]) expect(refund(hours).reason.length).toBeGreaterThan(10);
  });
});
