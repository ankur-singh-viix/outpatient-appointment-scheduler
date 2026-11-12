import type { RefundPolicy } from '../config.js';

export type CancelledBy = 'PATIENT' | 'DOCTOR' | 'SYSTEM';

export interface RefundDecision {
  amountPaise: number;
  percent: number;
  /** Human-readable explanation, stored on the refund and shown to the patient. */
  reason: string;
}

/**
 * How much of a PAID booking goes back when it is cancelled.
 * - The clinic cancels (doctor, or the system releasing a booking it could not keep): always the full amount.
 * - The patient cancels: the full amount if there is still plenty of notice, a configured share if there is some, nothing
 *   when the appointment is about to start.
 * Partial amounts round DOWN to whole paise so the refund can never exceed what was paid.
 */
export function refundFor(input: {
  paidPaise: number;
  appointmentStart: Date;
  now: Date;
  cancelledBy: CancelledBy;
  policy: RefundPolicy;
}): RefundDecision {
  const { paidPaise, policy } = input;
  if (input.cancelledBy !== 'PATIENT') {
    return { amountPaise: paidPaise, percent: 100, reason: 'Full refund: the appointment was cancelled by the clinic.' };
  }
  const hoursBefore = (input.appointmentStart.getTime() - input.now.getTime()) / 3_600_000;
  if (hoursBefore >= policy.fullRefundHoursBefore) {
    return { amountPaise: paidPaise, percent: 100, reason: `Full refund: cancelled at least ${policy.fullRefundHoursBefore} hours before the appointment.` };
  }
  if (hoursBefore >= policy.partialRefundHoursBefore && policy.partialRefundPercent > 0) {
    return {
      amountPaise: Math.floor((paidPaise * policy.partialRefundPercent) / 100),
      percent: policy.partialRefundPercent,
      reason: `${policy.partialRefundPercent}% refund: cancelled less than ${policy.fullRefundHoursBefore} hours but at least ${policy.partialRefundHoursBefore} hours before the appointment.`,
    };
  }
  return { amountPaise: 0, percent: 0, reason: `No refund: cancelled less than ${policy.partialRefundHoursBefore} hours before the appointment.` };
}
