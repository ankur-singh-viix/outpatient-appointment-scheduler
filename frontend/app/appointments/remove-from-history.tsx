'use client';

import { Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { REMOVE_CONFIRM_TEXT, bulkSummary, removeMany } from '@/lib/past-history';
import type { PatientAppointment, Session } from '@/lib/types';

const hideRequest = (session: Session, id: string) => api(`/appointments/${id}/hide-from-history`, { method: 'POST', token: session.accessToken, body: {} });

/**
 * "Remove from history" on one past booking. It asks first, says that only the list changes, and shows the server's answer if it
 * refuses (for example while a refund is still being processed). Nothing is deleted: receipts stay in Payments.
 */
export function RemoveFromHistory({ appointment, session, onRemoved }: { appointment: PatientAppointment; session: Session; onRemoved: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await hideRequest(session, appointment.id);
      setOpen(false);
      onRemoved('Removed from your history. Its receipt, if any, is still in Payments.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const label = `Remove from history: appointment with ${appointment.doctor.name} on ${formatDate(appointment.date, { weekday: 'long' })}`;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-9"
        aria-label={label}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2Icon aria-hidden /> Remove from history
      </Button>
      <ConfirmDialog
        open={open}
        title="Remove from your history?"
        description={REMOVE_CONFIRM_TEXT}
        confirmLabel="Remove"
        cancelLabel="Keep it"
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** "Remove all cancelled": the same removal for every cancelled booking that can go, skipping any the server refuses. */
export function RemoveAllCancelled({ ids, session, onDone }: { ids: string[]; session: Session; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const result = await removeMany(ids, (id) => hideRequest(session, id).then(() => undefined), errorMessage);
    setBusy(false);
    setOpen(false);
    onDone(bulkSummary(result));
  };

  if (ids.length === 0) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2Icon aria-hidden /> Remove all cancelled ({ids.length})
      </Button>
      <ConfirmDialog
        open={open}
        title={`Remove ${ids.length} cancelled booking${ids.length === 1 ? '' : 's'} from your history?`}
        description={`${REMOVE_CONFIRM_TEXT} Any that cannot be removed right now are skipped.`}
        confirmLabel="Remove all"
        cancelLabel="Keep them"
        busy={busy}
        onConfirm={() => void run()}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
