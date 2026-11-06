import { StethoscopeIcon } from 'lucide-react';
import { PaymentBadge } from '@/components/payment-info';
import { formatDate, formatDateTime, formatPaise, formatTimeRange } from '@/lib/format';
import type { PaymentHistoryItem, RefundSummary } from '@/lib/types';

const REFUND_STATUS: Record<RefundSummary['status'], string> = { PROCESSED: 'Processed', PENDING: 'In progress', FAILED: 'Failed' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="receipt-block min-w-0">
      <dt className="text-[8.5pt] font-semibold tracking-wider text-neutral-500 uppercase">{label}</dt>
      <dd className="mt-0.5 text-[10.5pt] leading-snug font-medium wrap-anywhere text-neutral-900">{children}</dd>
    </div>
  );
}

/**
 * One payment receipt, laid out for A4 paper as well as for the screen: a single column of fixed-width blocks that never splits a
 * block across pages. The same component fills the on-screen receipt dialog and the print sheet, so what is read is what is printed.
 * Plain neutral colours and a table for the money keep it legible in black and white.
 */
export function ReceiptSheet({ item, patientName }: { item: PaymentHistoryItem; patientName: string }) {
  const { appointment } = item;
  const refunded = item.refundedPaise;
  const net = item.amountPaise - refunded;

  return (
    <article className="receipt-sheet mx-auto w-full max-w-[182mm] rounded-xl border border-neutral-300 bg-white p-6 text-neutral-900" aria-label={`Payment receipt ${item.receiptNumber ?? ''}`}>
      <header className="receipt-block flex items-start justify-between gap-4 border-b-2 border-neutral-800 pb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-10 items-center justify-center rounded-lg bg-teal-700 text-white" aria-hidden>
            <StethoscopeIcon className="size-6" />
          </span>
          <div>
            <p className="text-[15pt] leading-tight font-bold">CareSlot</p>
            <p className="text-[9pt] text-neutral-600">Outpatient appointments</p>
          </div>
        </div>
        <div className="text-right">
          <h2 className="text-[15pt] leading-tight font-bold">Payment receipt</h2>
          <p className="mt-0.5 text-[9.5pt] text-neutral-700">
            Receipt no. <span className="font-mono wrap-anywhere">{item.receiptNumber ?? 'not issued yet'}</span>
          </p>
          {item.paidAt && <p className="text-[9.5pt] text-neutral-700">Issued {formatDateTime(item.paidAt)}</p>}
        </div>
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4 border-b border-neutral-300 pb-4">
        <Field label="Patient">{patientName}</Field>
        <Field label="Doctor">
          {appointment.doctorName}
          <span className="block text-[9.5pt] font-normal text-neutral-600">{appointment.specialty}</span>
        </Field>
        <Field label="Clinic">
          {appointment.clinicName}
          <span className="block text-[9.5pt] font-normal text-neutral-600">{appointment.clinicAddress}</span>
        </Field>
        <Field label="Appointment">
          {formatDate(appointment.date, { weekday: 'long' })}
          <span className="block text-[9.5pt] font-normal text-neutral-600">{formatTimeRange(appointment.startTime, appointment.endTime)}</span>
        </Field>
      </dl>

      <section className="receipt-block mt-4" aria-labelledby={`pay-${item.id}`}>
        <h3 id={`pay-${item.id}`} className="mb-1.5 text-[9pt] font-semibold tracking-wider text-neutral-500 uppercase">
          Payment
        </h3>
        <table className="w-full border-collapse text-[10.5pt]">
          <thead>
            <tr className="border-b border-neutral-400 text-left text-[9pt] text-neutral-600">
              <th scope="col" className="py-1.5 font-semibold">
                Description
              </th>
              <th scope="col" className="py-1.5 text-right font-semibold">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-neutral-200">
              <td className="py-2 pr-4">Consultation fee, {appointment.doctorName}</td>
              <td className="py-2 text-right tabular-nums">{formatPaise(item.amountPaise)}</td>
            </tr>
            {refunded > 0 && (
              <tr className="border-b border-neutral-200">
                <td className="py-2 pr-4">Less: refunds processed</td>
                <td className="py-2 text-right tabular-nums">− {formatPaise(refunded)}</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-800 font-bold">
              <td className="py-2 pr-4">{refunded > 0 ? 'Net amount paid' : 'Total paid'}</td>
              <td className="py-2 text-right text-[12pt] tabular-nums">{formatPaise(net)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <dl className="receipt-block mt-4 grid grid-cols-2 gap-x-8 gap-y-3 border-t border-neutral-300 pt-4">
        <Field label="Payment status">
          <PaymentBadge status={item.displayStatus} />
        </Field>
        <Field label="Paid on">{item.paidAt ? formatDateTime(item.paidAt) : 'Not paid yet'}</Field>
        <Field label="Transaction ID">
          <span className="font-mono text-[9.5pt]">{item.receiptNumber ?? '—'}</span>
        </Field>
        <Field label="Order reference">
          <span className="font-mono text-[9.5pt]">{item.orderId}</span>
        </Field>
      </dl>

      {item.refunds.length > 0 && (
        <section className="receipt-block mt-4 border-t border-neutral-300 pt-4" aria-labelledby={`refunds-${item.id}`}>
          <h3 id={`refunds-${item.id}`} className="mb-1.5 text-[9pt] font-semibold tracking-wider text-neutral-500 uppercase">
            Refunds
          </h3>
          <table className="w-full border-collapse text-[9.5pt]">
            <thead>
              <tr className="border-b border-neutral-400 text-left text-[8.5pt] text-neutral-600">
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Requested
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
                  Amount
                </th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Status
                </th>
                <th scope="col" className="py-1.5 font-semibold">
                  Reference and reason
                </th>
              </tr>
            </thead>
            <tbody>
              {item.refunds.map((refund) => (
                <tr key={refund.id} className="receipt-row border-b border-neutral-200 align-top">
                  <td className="py-2 pr-3">{formatDateTime(refund.createdAt)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatPaise(refund.amountPaise)}</td>
                  <td className="py-2 pr-3">
                    {REFUND_STATUS[refund.status]}
                    {refund.processedAt && <span className="block text-[8.5pt] text-neutral-600">{formatDateTime(refund.processedAt)}</span>}
                  </td>
                  <td className="py-2 wrap-anywhere">
                    {refund.reference && <span className="block font-mono text-[9pt]">{refund.reference}</span>}
                    <span className="text-neutral-600">{refund.reason}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="receipt-block mt-5 border-t border-neutral-300 pt-3 text-[8.5pt] text-neutral-600">
        This is a computer-generated receipt and needs no signature. Keep the transaction ID and order reference if you contact us about this payment.
      </footer>
    </article>
  );
}
