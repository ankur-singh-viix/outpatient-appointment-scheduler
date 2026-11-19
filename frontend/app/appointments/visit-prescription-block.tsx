'use client';

import { FileTextIcon } from 'lucide-react';
import type { PatientPrescription } from '@/lib/types';

/**
 * Compact finalized-prescription block for a completed visit.
 * Shows only fields that exist; never invents diagnosis, notes or medications.
 */
export function VisitPrescriptionBlock({ prescription }: { prescription: PatientPrescription | null }) {
  return (
    <div className="border-t pt-4">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
        <FileTextIcon className="size-3.5" aria-hidden />
        Prescription
      </p>
      {!prescription ? (
        <p className="text-sm text-muted-foreground">No finalized prescription for this visit.</p>
      ) : (
        <div className="space-y-2 text-sm">
          {prescription.diagnosis && (
            <p>
              <span className="font-medium text-foreground">Diagnosis: </span>
              {prescription.diagnosis}
            </p>
          )}
          {prescription.notes && (
            <p>
              <span className="font-medium text-foreground">Notes: </span>
              {prescription.notes}
            </p>
          )}
          {!prescription.diagnosis && !prescription.notes && (
            <p className="text-muted-foreground">No diagnosis or consultation notes recorded.</p>
          )}
          {prescription.medications.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {prescription.medications.map((med, index) => (
                <li key={`${med.name}-${index}`}>
                  {med.name}
                  {[med.dosage, med.frequency, med.duration].filter(Boolean).length > 0 && (
                    <> — {[med.dosage, med.frequency, med.duration].filter(Boolean).join(', ')}</>
                  )}
                  {med.instructions ? ` (${med.instructions})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
