'use client';

import { PrinterIcon, StethoscopeIcon } from 'lucide-react';
import { useEffect } from 'react';
import { PaymentBadge } from '@/components/payment-info';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { formatDate, formatDateTime, formatPaise, formatTimeRange } from '@/lib/format';
import type { PaymentHistoryItem } from '@/lib/types';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium break-words text-foreground">{children}</dd>
    </div>
  );
}

/**
 * A payment receipt that can be read on screen or printed. Printing hides everything except this dialog (see the print rules
 * in globals.css), so "Save as PDF" in the print window gives a clean one-page receipt.
 */
export function ReceiptDialog({
  item,
  patientName,
  open,
  onOpenChange,
  autoPrint = false,
}: {
  item: PaymentHistoryItem | null;
  patientName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the print window as soon as the receipt is showing (the "Print" button on a payment card). */
  autoPrint?: boolean;
}) {
  useEffect(() => {
    if (!open || !autoPrint) return;
    const timer = setTimeout(() => window.print(), 400); // after the dialog has finished appearing
    return () => clearTimeout(timer);
  }, [open, autoPrint]);

  if (!item) return null;
  const { appointment } = item;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="print-receipt max-w-lg">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3 border-b pb-4">
            <div className="flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden>
                <StethoscopeIcon className="size-5" />
              </span>
              <div>
                <p className="text-lg leading-tight font-bold text-foreground">CareSlot</p>
                <p className="text-xs text-muted-foreground">Outpatient appointments</p>
              </div>
            </div>
            <PaymentBadge status={item.displayStatus} />
          </div>

          <div>
            <DialogTitle>Payment receipt</DialogTitle>
            <DialogDescription>Receipt number {item.receiptNumber ?? 'not issued yet'}</DialogDescription>
          </div>

          <dl className="divide-y">
            <Row label="Patient">{patientName}</Row>
            <Row label="Doctor">
              {appointment.doctorName} · {appointment.specialty}
            </Row>
            <Row label="Clinic">
              {appointment.clinicName}, {appointment.clinicAddress}
            </Row>
            <Row label="Appointment">
              {formatDate(appointment.date, { weekday: 'long' })}, {formatTimeRange(appointment.startTime, appointment.endTime)}
            </Row>
            <Row label="Amount paid">{formatPaise(item.amountPaise)}</Row>
            {item.paidAt && <Row label="Paid on">{formatDateTime(item.paidAt)}</Row>}
            <Row label="Order reference">
              <span className="font-mono text-xs">{item.orderId}</span>
            </Row>
            {item.receiptNumber && (
              <Row label="Transaction ID">
                <span className="font-mono text-xs">{item.receiptNumber}</span>
              </Row>
            )}
            {item.refunds.map((refund) => (
              <Row key={refund.id} label="Refund">
                {formatPaise(refund.amountPaise)} ·{' '}
                {refund.status === 'PROCESSED' ? 'Processed' : refund.status === 'FAILED' ? 'Failed' : 'In progress'}
                {refund.reference && <span className="block font-mono text-xs text-muted-foreground">Reference {refund.reference}</span>}
              </Row>
            ))}
          </dl>

          <p className="text-xs text-muted-foreground">This is a computer-generated receipt and needs no signature.</p>

          <div className="no-print flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button variant="outline" size="lg" className="h-9" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button size="lg" className="h-9 gap-2" onClick={() => window.print()}>
              <PrinterIcon aria-hidden />
              Print receipt
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
