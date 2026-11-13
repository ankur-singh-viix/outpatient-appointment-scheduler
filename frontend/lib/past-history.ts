import type { PatientAppointment } from './types';

/** What the person is told before a booking is removed from their list. Nothing is deleted: receipts live under Payments. */
export const REMOVE_CONFIRM_TEXT = 'This only removes it from your list. Receipts stay available in Payments.';

/** The bookings that are over, and so can be removed from the list. The server decides for real; this only decides whether to offer the button. */
const REMOVABLE_STATUSES: PatientAppointment['status'][] = ['CANCELLED', 'COMPLETED', 'NO_SHOW'];

/**
 * Whether to offer "Remove from history" on a past booking: it is over, and no money is unsettled (a payment still pending, a refund on
 * its way, or a refund that failed). The server refuses the same cases, so this is only to avoid offering a button that cannot work.
 */
export function canRemoveFromHistory(appointment: Pick<PatientAppointment, 'status' | 'payment'>): boolean {
  if (!REMOVABLE_STATUSES.includes(appointment.status)) return false;
  const payment = appointment.payment;
  if (!payment) return true;
  if (payment.displayStatus === 'PAYMENT_PENDING' || payment.displayStatus === 'REFUND_PENDING') return false;
  return !payment.refunds.some((refund) => refund.status === 'FAILED');
}

/** The cancelled bookings that can be removed together by "Remove all cancelled". */
export function removableCancelled(items: Pick<PatientAppointment, 'id' | 'status' | 'payment'>[]): string[] {
  return items.filter((item) => item.status === 'CANCELLED' && canRemoveFromHistory(item)).map((item) => item.id);
}

export interface BulkResult {
  removed: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * Removes bookings one at a time, in order. One the server refuses (money still settling, or it changed since the page loaded) is
 * skipped with its reason, and the rest carry on: a refusal never stops the others.
 */
export async function removeMany(ids: string[], hide: (id: string) => Promise<void>, describe: (error: unknown) => string): Promise<BulkResult> {
  const result: BulkResult = { removed: [], skipped: [] };
  for (const id of ids) {
    try {
      await hide(id);
      result.removed.push(id);
    } catch (error) {
      result.skipped.push({ id, reason: describe(error) });
    }
  }
  return result;
}

/** One sentence for what a bulk removal did, including how many were skipped and why. */
export function bulkSummary(result: BulkResult): string {
  const { removed, skipped } = result;
  const noun = (count: number) => `${count} cancelled booking${count === 1 ? '' : 's'}`;
  if (skipped.length === 0) return removed.length === 0 ? 'Nothing was removed.' : `Removed ${noun(removed.length)} from your history.`;
  const why = [...new Set(skipped.map((entry) => entry.reason))].join(' ');
  return `${removed.length === 0 ? 'Nothing was removed' : `Removed ${noun(removed.length)}`}. ${skipped.length} could not be removed: ${why}`;
}
