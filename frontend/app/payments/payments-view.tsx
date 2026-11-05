'use client';

import { CircleDollarSignIcon, ClockIcon, EyeIcon, MapPinIcon, PrinterIcon, ReceiptIcon, RotateCcwIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { PaymentBadge } from '@/components/payment-info';
import { ReceiptDialog } from '@/components/receipt-dialog';
import { useReceiptPrinter } from '@/components/receipt-print';
import { RequireRole } from '@/components/require-role';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, formatPaise, formatTimeRange } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { PaymentHistoryItem, RefundSummary, Session } from '@/lib/types';

export function PaymentsView() {
  return (
    <RequireRole role="PATIENT" nextPath="/payments">
      {(session) => <Payments session={session} />}
    </RequireRole>
  );
}

function Payments({ session }: { session: Session }) {
  const history = useQuery(`payments-page:${session.user.id}`, () => api<PaymentHistoryItem[]>('/payments/mine', { token: session.accessToken }));
  const [receipt, setReceipt] = useState<PaymentHistoryItem | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const printer = useReceiptPrinter(session.user.name);

  const items = history.data ?? history.previous;
  if (!items && history.loading) return <Spinner label="Loading your payments…" />;
  if (history.error) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={history.reload}>
            Try again
          </Button>
        }
      >
        Could not load your payments. {history.error}
      </Alert>
    );
  }
  if (!items || items.length === 0) {
    return (
      <EmptyState title="No payments yet" icon={ReceiptIcon}>
        <p>When you pay for an appointment, the payment, its receipt and any refund will show up here.</p>
        <Link href="/" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
          Find a doctor
        </Link>
      </EmptyState>
    );
  }

  const paid = items.filter((item) => item.receiptNumber !== null); // a receipt number exists once the payment has gone through
  const totalPaid = paid.reduce((sum, item) => sum + item.amountPaise, 0);
  const totalRefunded = items.reduce((sum, item) => sum + item.refundedPaise, 0);
  const waiting = items.filter((item) => item.displayStatus === 'PAYMENT_PENDING' || item.displayStatus === 'PAYMENT_FAILED').length;

  const open = (item: PaymentHistoryItem) => {
    setReceipt(item);
    setReceiptOpen(true);
  };

  return (
    <div className="space-y-6">
      <section aria-label="Summary" className="grid gap-3 sm:grid-cols-3">
        <Stat icon={<CircleDollarSignIcon className="size-4" aria-hidden />} label="Total paid" value={formatPaise(totalPaid)} />
        <Stat icon={<RotateCcwIcon className="size-4" aria-hidden />} label="Refunded" value={formatPaise(totalRefunded)} />
        <Stat icon={<ClockIcon className="size-4" aria-hidden />} label="Needs attention" value={String(waiting)} />
      </section>

      <ul className="space-y-4" aria-label="Payments">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 fill-mode-backwards"
            style={{ animationDelay: `${Math.min(index, 5) * 40}ms` }}
          >
            <PaymentCard item={item} onView={() => open(item)} onPrint={() => printer.print([item])} />
          </li>
        ))}
      </ul>

      {paid.length > 1 && (
        <div className="flex justify-end">
          <Button variant="outline" size="lg" className="h-9 gap-2" onClick={() => printer.print(paid)}>
            <PrinterIcon aria-hidden />
            Print all receipts ({paid.length})
          </Button>
        </div>
      )}

      <ReceiptDialog item={receipt} patientName={session.user.name} open={receiptOpen} onOpenChange={setReceiptOpen} onPrint={(item) => printer.print([item])} />
      {printer.sheets}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="[--card-spacing:--spacing(4)]">
      <CardContent>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {icon}
          {label}
        </p>
        <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words text-foreground">{children}</dd>
    </div>
  );
}

function RefundRow({ refund }: { refund: RefundSummary }) {
  const amount = formatPaise(refund.amountPaise);
  // Complete only once the payment provider has confirmed it: until then it is described as in progress.
  const headline =
    refund.status === 'PROCESSED'
      ? `Refunded ${amount}`
      : refund.status === 'FAILED'
        ? `Refund of ${amount} could not be completed`
        : `Refund of ${amount} in progress`;
  const status = refund.status === 'PROCESSED' ? 'Processed' : refund.status === 'FAILED' ? 'Failed' : 'Pending';
  return (
    <li className="rounded-lg bg-muted/60 p-3 text-sm">
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-foreground">{headline}</span>
        <span className="text-muted-foreground">{status}</span>
      </p>
      <p className="mt-0.5 text-muted-foreground">{refund.reason}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Requested {formatDateTime(refund.createdAt)}
        {refund.processedAt && <> · Completed {formatDateTime(refund.processedAt)}</>}
        {refund.reference && <> · Reference <span className="font-mono">{refund.reference}</span></>}
      </p>
    </li>
  );
}

function PaymentCard({ item, onView, onPrint }: { item: PaymentHistoryItem; onView: () => void; onPrint: () => void }) {
  const { appointment } = item;
  const hasReceipt = item.receiptNumber !== null;
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardContent className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-base font-semibold text-foreground">
              {appointment.doctorName} <span className="font-normal text-muted-foreground">· {appointment.specialty}</span>
            </p>
            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <MapPinIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {appointment.clinicName}, {appointment.clinicAddress}
            </p>
            <p className="text-sm text-foreground/80">
              {formatDate(appointment.date, { weekday: 'long' })} · {formatTimeRange(appointment.startTime, appointment.endTime)}
            </p>
          </div>
          <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
            <p className="text-2xl font-bold text-foreground">{formatPaise(item.amountPaise)}</p>
            <PaymentBadge status={item.displayStatus} />
          </div>
        </div>

        <dl className="grid gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label={item.paidAt ? 'Paid on' : 'Started on'}>{formatDateTime(item.paidAt ?? item.createdAt)}</Detail>
          <Detail label="Transaction ID">{item.receiptNumber ? <span className="font-mono text-xs">{item.receiptNumber}</span> : 'Not paid yet'}</Detail>
          <Detail label="Order reference">
            <span className="font-mono text-xs">{item.orderId}</span>
          </Detail>
          {item.failureReason && item.displayStatus === 'PAYMENT_FAILED' && <Detail label="Reason">{item.failureReason}</Detail>}
        </dl>

        {item.refunds.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Refunds</h3>
            <ul className="space-y-2" aria-label="Refunds">
              {item.refunds.map((refund) => (
                <RefundRow key={refund.id} refund={refund} />
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t pt-4">
          {hasReceipt ? (
            <>
              <Button variant="outline" size="lg" className="h-9 gap-2" onClick={onView} aria-label={`View receipt for ${appointment.doctorName}`}>
                <EyeIcon aria-hidden />
                View receipt
              </Button>
              <Button variant="outline" size="lg" className="h-9 gap-2" onClick={onPrint} aria-label={`Print receipt for ${appointment.doctorName}`}>
                <PrinterIcon aria-hidden />
                Print
              </Button>
            </>
          ) : (
            <Link href="/appointments" className={buttonVariants({ size: 'lg', className: 'h-9' })}>
              {item.displayStatus === 'PAYMENT_FAILED' ? 'Try the payment again' : 'Complete payment'}
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
