import type { EntityManager } from 'typeorm';
import { QueueEntry, QueueEvent } from '../database/entities/index.js';

/**
 * Issues the next doctor-day token for a confirmed appointment as a BOOKED queue entry.
 * The caller must already hold the doctor row lock (same order as booking). Idempotent per appointment:
 * a second call returns the existing token and never allocates another.
 */
export async function issueBookedQueueToken(
  manager: EntityManager,
  input: { appointmentId: string; doctorId: string; patientId: string; queueDate: string; actorUserId: string },
): Promise<{ entryId: string; tokenNumber: number }> {
  const existing = await manager.findOneBy(QueueEntry, { appointmentId: input.appointmentId });
  if (existing) return { entryId: existing.id, tokenNumber: existing.tokenNumber };

  const [{ next }]: { next: number }[] = await manager.query(
    'SELECT COALESCE(MAX(token_number), 0) + 1 AS next FROM queue_entries WHERE doctor_id = $1 AND queue_date = $2',
    [input.doctorId, input.queueDate],
  );
  const entry = await manager.save(
    manager.create(QueueEntry, {
      appointmentId: input.appointmentId,
      doctorId: input.doctorId,
      patientId: input.patientId,
      queueDate: input.queueDate,
      tokenNumber: Number(next),
      status: 'BOOKED',
      checkedInAt: null,
      checkedInByUserId: null,
    }),
  );
  await manager.insert(QueueEvent, {
    entryId: entry.id,
    event: 'BOOKED',
    fromStatus: null,
    toStatus: 'BOOKED',
    actorUserId: input.actorUserId,
  });
  return { entryId: entry.id, tokenNumber: entry.tokenNumber };
}
