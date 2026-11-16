import { StethoscopeIcon } from 'lucide-react';
import { formatDate, formatDateTime, formatTimeRange } from '@/lib/format';
import type { PrescriptionDetail, PrescriptionMedication } from '@/lib/types';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="receipt-block min-w-0">
      <dt className="text-[8.5pt] font-semibold tracking-wider text-neutral-500 uppercase">{label}</dt>
      <dd className="mt-0.5 text-[10.5pt] leading-snug font-medium wrap-anywhere text-neutral-900">{children}</dd>
    </div>
  );
}

function medLine(med: PrescriptionMedication) {
  return [med.name, med.dosage, med.frequency, med.duration].filter(Boolean).join(' · ');
}

/**
 * One finalized prescription laid out for A4 paper and for the screen. Reuses the receipt print classes so the same stylesheet
 * removes the rest of the page and prints clean A4 sheets.
 */
export function PrescriptionSheet({ item }: { item: PrescriptionDetail }) {
  return (
    <article className="receipt-sheet mx-auto w-full max-w-[182mm] rounded-xl border border-neutral-300 bg-white p-6 text-neutral-900" aria-label={`Prescription for ${item.patient.name}`}>
      <header className="receipt-block flex items-start justify-between gap-4 border-b-2 border-neutral-800 pb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-10 items-center justify-center rounded-lg bg-teal-700 text-white" aria-hidden>
            <StethoscopeIcon className="size-6" />
          </span>
          <div>
            <p className="text-[15pt] leading-tight font-bold">CareSlot</p>
            <p className="text-[9pt] text-neutral-600">Outpatient prescription</p>
          </div>
        </div>
        <div className="text-right">
          <h2 className="text-[15pt] leading-tight font-bold">Prescription</h2>
          {item.finalizedAt && <p className="mt-0.5 text-[9.5pt] text-neutral-700">Finalized {formatDateTime(item.finalizedAt)}</p>}
        </div>
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4 border-b border-neutral-300 pb-4">
        <Field label="Patient">{item.patient.name}</Field>
        <Field label="Doctor">
          {item.doctor.name}
          <span className="block text-[9.5pt] font-normal text-neutral-600">{item.doctor.specialty}</span>
        </Field>
        <Field label="Clinic">
          {item.doctor.clinic.name}
          <span className="block text-[9.5pt] font-normal text-neutral-600">{item.doctor.clinic.address}</span>
        </Field>
        <Field label="Appointment">
          {formatDate(item.appointment.date, { weekday: 'long' })}
          <span className="block text-[9.5pt] font-normal text-neutral-600">{formatTimeRange(item.appointment.startTime, item.appointment.endTime)}</span>
        </Field>
      </dl>

      {item.diagnosis && (
        <section className="receipt-block mt-4" aria-labelledby={`dx-${item.id}`}>
          <h3 id={`dx-${item.id}`} className="mb-1 text-[9pt] font-semibold tracking-wider text-neutral-500 uppercase">
            Diagnosis
          </h3>
          <p className="text-[10.5pt] text-neutral-900">{item.diagnosis}</p>
        </section>
      )}

      <section className="receipt-block mt-4" aria-labelledby={`rx-${item.id}`}>
        <h3 id={`rx-${item.id}`} className="mb-1.5 text-[9pt] font-semibold tracking-wider text-neutral-500 uppercase">
          Medications
        </h3>
        <table className="w-full border-collapse text-[10.5pt]">
          <thead>
            <tr className="border-b border-neutral-400 text-left text-[9pt] text-neutral-600">
              <th scope="col" className="py-1.5 font-semibold">
                Medicine
              </th>
              <th scope="col" className="py-1.5 font-semibold">
                Instructions
              </th>
            </tr>
          </thead>
          <tbody>
            {item.medications.map((med, index) => (
              <tr key={`${med.name}-${index}`} className="border-b border-neutral-200 align-top">
                <td className="py-2 pr-4 font-medium">{medLine(med)}</td>
                <td className="py-2 text-neutral-700">{med.instructions?.trim() || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {item.notes && (
        <section className="receipt-block mt-4 border-t border-neutral-300 pt-4" aria-labelledby={`notes-${item.id}`}>
          <h3 id={`notes-${item.id}`} className="mb-1 text-[9pt] font-semibold tracking-wider text-neutral-500 uppercase">
            Notes
          </h3>
          <p className="text-[10.5pt] text-neutral-900 whitespace-pre-wrap">{item.notes}</p>
        </section>
      )}
    </article>
  );
}
