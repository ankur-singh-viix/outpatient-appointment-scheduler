'use client';

import { ClipboardListIcon, PrinterIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { usePrescriptionPrinter } from '@/components/prescription-print';
import { PrescriptionSheet } from '@/components/prescription-sheet';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatTimeRange } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { PrescriptionDetail, Session } from '@/lib/types';

/**
 * Finalized prescriptions for the doctors who assigned this receptionist. View and print only — no editing.
 */
export function PrescriptionsPanel({ session }: { session: Session }) {
  const list = useQuery(`reception-prescriptions:${session.user.id}`, () =>
    api<PrescriptionDetail[]>('/prescriptions/reception', { token: session.accessToken }),
  );
  const [selected, setSelected] = useState<PrescriptionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printer = usePrescriptionPrinter();

  const rows = list.data ?? list.previous ?? [];

  const open = async (id: string) => {
    setError(null);
    try {
      setSelected(await api<PrescriptionDetail>(`/prescriptions/reception/${id}`, { token: session.accessToken }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (list.loading && !list.data && !list.previous) return <Spinner label="Loading prescriptions…" />;
  if (list.error) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={list.reload}>
            Try again
          </Button>
        }
      >
        Could not load prescriptions. {list.error}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      {printer.sheets}
      {rows.length === 0 ? (
        <EmptyState title="No finalized prescriptions" icon={ClipboardListIcon}>
          <p>When a doctor finalizes a prescription for one of your assigned doctors, it appears here for printing.</p>
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Finalized prescriptions">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {row.patient.name}
                  <span className="text-sm font-normal text-muted-foreground"> · {row.doctor.name}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatDate(row.appointment.date)} · {formatTimeRange(row.appointment.startTime, row.appointment.endTime)}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void open(row.id)}>
                View
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setSelected(row);
                  printer.print([row]);
                }}
              >
                <PrinterIcon aria-hidden /> Print
              </Button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-foreground">Prescription preview</h3>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => printer.print([selected])}>
                <PrinterIcon aria-hidden /> Print A4
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </div>
          <PrescriptionSheet item={selected} />
        </div>
      )}
    </div>
  );
}
