import type { SchedulingMode, Slot } from '@/lib/types';

/**
 * What a slot chip says about itself. Stream (one patient per slot): "Available", "Booked", or "Session full" when the session's
 * booking cap is reached. Wave (several patients share a slot): "2/3 available" while places are left, then "Full". Text always
 * accompanies the colour, so colour is never the only cue.
 */
export function slotStatusText(slot: Slot, mode: SchedulingMode, capacityPerSlot: number): string {
  if (slot.status === 'PAST') return 'Passed';
  if (mode === 'WAVE') return slot.status === 'AVAILABLE' ? `${slot.remaining ?? 0}/${slot.capacityPerSlot ?? capacityPerSlot} available` : 'Full';
  return slot.status === 'AVAILABLE' ? 'Available' : slot.status === 'FULL' ? 'Session full' : 'Booked';
}

/** Chip colours by status: open slots teal, taken or full ones neutral, a full session amber, passed ones faded. */
export const SLOT_CHIP_STYLES: Record<Slot['status'], string> = {
  AVAILABLE: 'border-primary/40 bg-card text-primary hover:bg-accent/50',
  BOOKED: 'border-border bg-muted text-muted-foreground',
  FULL: 'border-amber-200 bg-amber-50 text-amber-800',
  PAST: 'border-border bg-muted/50 text-muted-foreground/70',
};
