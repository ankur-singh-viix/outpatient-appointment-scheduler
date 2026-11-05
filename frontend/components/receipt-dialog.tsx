'use client';

import { PrinterIcon } from 'lucide-react';
import { ReceiptSheet } from '@/components/receipt-sheet';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { PaymentHistoryItem } from '@/lib/types';

/**
 * A payment receipt to read on screen. It shows the same sheet that is printed; the Print button hands the receipt to the page's
 * receipt printer (see receipt-print.tsx), which prints it on its own, without this dialog or the dashboard around it.
 */
export function ReceiptDialog({
  item,
  patientName,
  open,
  onOpenChange,
  onPrint,
}: {
  item: PaymentHistoryItem | null;
  patientName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrint: (item: PaymentHistoryItem) => void;
}) {
  if (!item) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto sm:max-w-3xl">
        <DialogTitle className="sr-only">Payment receipt</DialogTitle>
        <DialogDescription className="sr-only">Receipt number {item.receiptNumber ?? 'not issued yet'}</DialogDescription>
        <div className="overflow-x-auto">
          <ReceiptSheet item={item} patientName={patientName} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="outline" size="lg" className="h-9" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button size="lg" className="h-9 gap-2" onClick={() => onPrint(item)}>
            <PrinterIcon aria-hidden />
            Print receipt
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
