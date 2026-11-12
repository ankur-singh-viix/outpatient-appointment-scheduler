'use client';

import { MinusIcon, PlusIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import type { Session } from '@/lib/types';

/** The Wave session whose patients per slot are being changed. */
export interface CapacityTarget {
  id: string;
  /** "Monday" for a recurring session, "Thursday, 12 Nov 2026" for one date. */
  title: string;
  capacityPerSlot: number;
  /** The most patients booked in any upcoming slot of this session. */
  maxBooked: number;
}

const MAX_PER_SLOT = 100;

/**
 * Change how many patients each slot of a Wave session takes, separately from its hours. Raising it opens the extra places at once.
 * Lowering it never cancels or moves anyone: if a slot already holds more patients than the new number, they stay booked and that
 * slot takes no new bookings until enough of them have left. The only warning shown is that one, and only when it applies.
 */
export function AdjustCapacityDialog({ session, target, onClose, onApplied }: { session: Session; target: CapacityTarget | null; onClose: () => void; onApplied: (message: string) => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md sm:max-w-md">
        {/* Keyed by session, so each one starts from its own capacity. */}
        {target && <CapacityForm key={target.id} session={session} target={target} onClose={onClose} onApplied={onApplied} />}
      </DialogContent>
    </Dialog>
  );
}

function CapacityForm({ session, target, onClose, onApplied }: { session: Session; target: CapacityTarget; onClose: () => void; onApplied: (message: string) => void }) {
  const [value, setValue] = useState(target.capacityPerSlot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_PER_SLOT;
  const unchanged = value === target.capacityPerSlot;
  const over = valid && value < target.maxBooked;
  const step = (by: number) => setValue((current) => Math.min(MAX_PER_SLOT, Math.max(1, (Number.isFinite(current) ? current : target.capacityPerSlot) + by)));

  const save = async () => {
    if (!valid || unchanged || busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api<{ overCapacitySlots: number }>(`/doctor-portal/availability/${target.id}/capacity`, {
        method: 'POST',
        token: session.accessToken,
        body: { capacityPerSlot: value },
      });
      onApplied(
        `${target.title}: ${value} ${value === 1 ? 'patient' : 'patients'} per slot.${done.overCapacitySlots > 0 ? ` ${done.overCapacitySlots === 1 ? 'One slot is' : `${done.overCapacitySlots} slots are`} over capacity: everyone stays booked, and no new bookings are taken there until places free up.` : ''}`,
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <DialogTitle>Adjust capacity · {target.title}</DialogTitle>
        <DialogDescription>How many patients each slot takes. The hours do not change.</DialogDescription>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/60 p-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Current</p>
          <p className="text-base font-semibold text-foreground">{target.capacityPerSlot} per slot</p>
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">New</p>
          <p className={unchanged || !valid ? 'text-base font-semibold text-muted-foreground' : 'text-base font-semibold text-primary'}>{valid ? `${value} per slot` : '—'}</p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="capacity-new">Patients per slot</Label>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" aria-label="One fewer patient per slot" onClick={() => step(-1)} disabled={busy || value <= 1}>
            <MinusIcon aria-hidden />
          </Button>
          <Input id="capacity-new" type="number" inputMode="numeric" min={1} max={MAX_PER_SLOT} value={Number.isFinite(value) ? value : ''} onChange={(event) => setValue(Number(event.target.value))} className="h-10 w-24 text-center" />
          <Button type="button" variant="outline" size="icon" aria-label="One more patient per slot" onClick={() => step(1)} disabled={busy || value >= MAX_PER_SLOT}>
            <PlusIcon aria-hidden />
          </Button>
        </div>
        {!valid && <p className="text-sm text-destructive">Enter a whole number from 1 to {MAX_PER_SLOT}.</p>}
      </div>

      {over && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" role="status">
          A slot already has {target.maxBooked} booked. They all stay booked; that slot takes no new bookings until it drops below {value}.
        </p>
      )}
      {error && <Alert>{error}</Alert>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="lg" className="h-9" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" size="lg" className="h-9 gap-2" disabled={busy || !valid || unchanged} onClick={() => void save()}>
          <UsersIcon aria-hidden />
          {busy ? 'Saving…' : 'Save capacity'}
        </Button>
      </div>
    </div>
  );
}
