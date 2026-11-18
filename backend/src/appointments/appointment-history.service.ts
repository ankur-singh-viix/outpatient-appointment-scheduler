import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/auth.types.js';
import { Patient } from '../database/entities/index.js';
import { PaymentsService } from '../payments/payments.service.js';

/** Statuses a booking can be removed from the patient's list in: it is over. Active bookings (pending or confirmed) never can. */
export const HIDEABLE_STATUSES = ['CANCELLED', 'COMPLETED', 'NO_SHOW'];

/** True when a query failed because a column does not exist (the database has not been migrated to 014 yet). */
export function isMissingColumn(error: unknown): boolean {
  const code = (error as { code?: unknown; driverError?: { code?: unknown } } | null) ?? {};
  return code.code === '42703' || code.driverError?.code === '42703';
}

/**
 * Lets a patient remove a past booking from their own list. The booking is not deleted or changed in any way that other views can
 * see: only `hidden_by_patient_at` is set, and only the patient's own list reads it. Payments, receipts, refunds and the doctor's and
 * receptionist's views are untouched, so a hidden booking's receipt stays reachable from Payments.
 *
 * Refused (409, nothing written) when the booking is still active, or when money is not settled: a payment still pending, a refund
 * on its way, or a refund that failed. Asking again for one already removed is answered, not repeated.
 */
@Injectable()
export class AppointmentHistoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly payments: PaymentsService,
  ) {}

  async hide(user: AuthUser, id: string): Promise<{ id: string; hidden: true; alreadyHidden: boolean }> {
    const patient = await this.dataSource.getRepository(Patient).findOne({ where: { userId: user.id }, select: { id: true } });
    if (!patient) throw new ForbiddenException('Only patients with a patient profile have appointments.');

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Someone else's appointment looks like a missing one. The row is locked while it is judged and marked.
        const [row]: { status: string; hidden: boolean }[] = await manager.query(
          'SELECT status::text AS status, hidden_by_patient_at IS NOT NULL AS hidden FROM appointments WHERE id = $1 AND patient_id = $2 FOR UPDATE',
          [id, patient.id],
        );
        if (!row) throw new NotFoundException('Appointment not found.');
        if (row.hidden) return { id, hidden: true as const, alreadyHidden: true };

        if (!HIDEABLE_STATUSES.includes(row.status)) {
          throw refused('NOT_PAST', 'Only a cancelled or completed appointment can be removed from your history. This one is still active.');
        }
        const payment = (await this.payments.summariesFor([id])).get(id);
        if (payment) {
          if (payment.displayStatus === 'PAYMENT_PENDING') throw refused('PAYMENT_UNSETTLED', 'The payment for this booking is not settled yet, so it cannot be removed from your history.');
          if (payment.displayStatus === 'REFUND_PENDING') throw refused('REFUND_PENDING', 'A refund for this booking is still being processed, so it cannot be removed from your history yet.');
          if (payment.refunds.some((refund) => refund.status === 'FAILED')) throw refused('REFUND_UNSETTLED', 'A refund for this booking did not go through and needs attention, so it cannot be removed from your history.');
        }

        await manager.query('UPDATE appointments SET hidden_by_patient_at = now() WHERE id = $1 AND patient_id = $2 AND hidden_by_patient_at IS NULL', [id, patient.id]);
        return { id, hidden: true as const, alreadyHidden: false };
      });
    } catch (error) {
      if (isMissingColumn(error)) throw new ServiceUnavailableException('Removing bookings from history is not available yet: the database has not been updated (migration 014).');
      throw error;
    }
  }
}

const refused = (code: string, message: string) => new ConflictException({ statusCode: 409, error: 'Conflict', code, message });
