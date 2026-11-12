'use client';

import type { ReactNode } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/**
 * Asks "are you sure?" before something that cannot be undone with one click. It stays open while the action runs, shows the
 * server's answer if it is refused, and can explain why the action is not possible right now (`unavailableReason`), in which case
 * the confirm button is not offered.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Keep it',
  busy = false,
  error,
  unavailableReason,
  children,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  /** When set, the action is refused up front: this is shown instead of the confirm button. */
  unavailableReason?: ReactNode;
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent>
        <div className="space-y-4">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-1">{description}</DialogDescription>
          </div>
          {children}
          {unavailableReason && <Alert tone="info">{unavailableReason}</Alert>}
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="lg" className="h-9" onClick={onClose} disabled={busy}>
              {unavailableReason ? 'Close' : cancelLabel}
            </Button>
            {!unavailableReason && (
              <Button type="button" size="lg" disabled={busy} onClick={onConfirm} className="h-9 bg-destructive text-white hover:bg-destructive/90">
                {busy ? 'Working…' : confirmLabel}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
