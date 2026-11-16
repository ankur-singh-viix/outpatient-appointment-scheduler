'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PrescriptionSheet } from '@/components/prescription-sheet';
import type { PrescriptionDetail } from '@/lib/types';

/**
 * Printing prescriptions. Reuses the receipt print root class so globals.css A4 rules apply unchanged.
 */
export function usePrescriptionPrinter(): { print: (items: PrescriptionDetail[]) => void; sheets: ReactNode } {
  const [batch, setBatch] = useState<PrescriptionDetail[] | null>(null);

  useEffect(() => {
    if (!batch) return;
    const finished = () => setBatch(null);
    window.addEventListener('afterprint', finished, { once: true });
    const timer = setTimeout(() => window.print(), 150);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('afterprint', finished);
    };
  }, [batch]);

  const sheets = batch
    ? createPortal(
        <div className="receipt-print-root" aria-hidden>
          {batch.map((item) => (
            <PrescriptionSheet key={item.id} item={item} />
          ))}
        </div>,
        document.body,
      )
    : null;

  return { print: (items) => setBatch([...items]), sheets };
}
