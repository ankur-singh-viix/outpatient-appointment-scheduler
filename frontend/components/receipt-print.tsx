'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ReceiptSheet } from '@/components/receipt-sheet';
import type { PaymentHistoryItem } from '@/lib/types';

/**
 * Printing receipts. `print(items)` puts one receipt sheet per item into a dedicated print container and opens the browser's print
 * window. On screen that container does not exist; when printing, the stylesheet (globals.css) removes everything else on the page
 * (the navigation, sidebar, buttons and dashboard) from the layout, sets the page to A4 and starts each receipt on a new page, so
 * one receipt, or many, print as clean, uncut A4 pages. Render `sheets` once, anywhere in the page.
 */
export function useReceiptPrinter(patientName: string): { print: (items: PaymentHistoryItem[]) => void; sheets: ReactNode } {
  const [batch, setBatch] = useState<PaymentHistoryItem[] | null>(null);

  useEffect(() => {
    if (!batch) return;
    const finished = () => setBatch(null);
    window.addEventListener('afterprint', finished, { once: true });
    const timer = setTimeout(() => window.print(), 150); // after the sheets have been drawn
    return () => {
      clearTimeout(timer);
      window.removeEventListener('afterprint', finished);
    };
  }, [batch]);

  const sheets = batch
    ? createPortal(
        <div className="receipt-print-root" aria-hidden>
          {batch.map((item) => (
            <ReceiptSheet key={item.id} item={item} patientName={patientName} />
          ))}
        </div>,
        document.body,
      )
    : null;

  // A new array each time, so asking to print the same receipt twice prints it twice.
  return { print: (items) => setBatch([...items]), sheets };
}
