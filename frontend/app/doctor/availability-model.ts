import type { AvailabilityRow, SchedulingMode } from '@/lib/types';

/** The part of an availability row that says how its hours are cut into slots. */
export type SessionSettings = Pick<AvailabilityRow, 'schedulingMode' | 'slotDurationMinutes' | 'capacityPerSlot' | 'capacity'>;

export const SLOT_MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

export const MODE_LABEL: Record<SchedulingMode, string> = { STREAM: 'Stream', WAVE: 'Wave' };

/** "09:30" -> minutes after midnight. */
export const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whole slots of `slotMinutes` that fit in a window, and so how many patients a Wave window can take in a day. */
export function slotsInWindow(start: string, end: string, slotMinutes: number): number {
  if (!start || !end || slotMinutes <= 0) return 0;
  return Math.max(0, Math.floor((toMinutes(end) - toMinutes(start)) / slotMinutes));
}

/** One line for a session's settings, e.g. "30-minute slots · up to 3 patients each" or "20-minute slots · one patient per slot". */
export function describeSettings(row: SessionSettings, fallbackMinutes: number): string {
  const length = `${row.slotDurationMinutes ?? fallbackMinutes}-minute slots`;
  return row.schedulingMode === 'WAVE'
    ? `${length} · up to ${row.capacityPerSlot} patients each`
    : `${length} · one patient per slot${row.capacity ? ` · max ${row.capacity} bookings` : ''}`;
}

/**
 * The request body for a session, with every field spelled out. Only the fields the server expects are sent (a row read from the
 * API also carries an id), and STREAM always sends one patient per slot.
 */
export function sessionBody(row: AvailabilityRow, fallbackMinutes: number) {
  const wave = row.schedulingMode === 'WAVE';
  return {
    startTime: row.startTime,
    endTime: row.endTime,
    schedulingMode: row.schedulingMode,
    slotDurationMinutes: row.slotDurationMinutes ?? fallbackMinutes,
    capacityPerSlot: wave ? row.capacityPerSlot : 1,
    ...(!wave && row.capacity !== null && { capacity: row.capacity }),
    ...(row.effectiveFrom && { effectiveFrom: row.effectiveFrom }),
    ...(row.effectiveTo && { effectiveTo: row.effectiveTo }),
  };
}
