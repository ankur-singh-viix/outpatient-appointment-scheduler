import { Badge } from '@/components/ui/badge';
import { formatDateTime, formatPaise } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PaymentDisplayStatus, PaymentSummary, RefundSummary } from '@/lib/types';

const LABELS: Record<PaymentDisplayStatus, { text: string; style: string }> = {
  PAID: { text: 'Paid', style: 'bg-emerald-50 text-emerald-700' },
  REFUND_PENDING: { text: 'Refund in progress', style: 'bg-amber-50 text-amber-700' },
  PARTIALLY_REFUNDED: { text: 'Partly refunded', style: 'bg-sky-50 text-sky-700' },
  REFUNDED: { text: 'Refunded', style: 'bg-sky-50 text-sky-700' },
  PAYMENT_PENDING: { text: 'Payment pending', style: 'bg-amber-50 text-amber-700' },
  PAYMENT_FAILED: { text: 'Payment failed', style: 'bg-red-50 text-red-700' },
  EXPIRED: { text: 'Not paid', style: 'bg-slate-100 text-slate-600' },
};

export function PaymentBadge({ status }: { status: PaymentDisplayStatus }) {
  const { text, style } = LABELS[status];
  return (
    <Badge variant="secondary" className={cn('font-semibold', style)}>
      {text}
    </Badge>
  );
}

function RefundLine({ refund }: { refund: RefundSummary }) {
  const amount = formatPaise(refund.amountPaise);
  // A refund is described as done only when the payment provider has confirmed it.
  const headline =
    refund.status === 'PROCESSED'
      ? `Refunded ${amount}${refund.processedAt ? ` on ${formatDateTime(refund.processedAt)}` : ''}`
      : refund.status === 'FAILED'
        ? `Refund of ${amount} could not be completed. We will follow up by email.`
        : `Refund of ${amount} is being processed. We will email you when it completes.`;
  return (
    <li className="space-y-0.5">
      <p className="font-medium text-foreground">{headline}</p>
      <p className="text-muted-foreground">
        {refund.reason}
        {refund.reference && <> · Reference {refund.reference}</>}
      </p>
    </li>
  );
}

/** Payment status, receipt and refund history for an appointment. Shows nothing for a payment that never happened. */
export function PaymentInfo({ payment }: { payment: PaymentSummary }) {
  if (payment.displayStatus === 'EXPIRED' || payment.displayStatus === 'PAYMENT_PENDING') return null;
  return (
    <div className="space-y-2 text-sm" data-testid="payment-info">
      <p className="flex flex-wrap items-center gap-2">
        <PaymentBadge status={payment.displayStatus} />
        <span className="text-foreground/80">{formatPaise(payment.amountPaise)}</span>
        {payment.paidAt && <span className="text-muted-foreground">paid {formatDateTime(payment.paidAt)}</span>}
      </p>
      {payment.displayStatus === 'PAYMENT_FAILED' && payment.failureReason && <p className="text-muted-foreground">{payment.failureReason}</p>}
      {payment.refunds.length > 0 && (
        <ul className="space-y-2" aria-label="Refunds">
          {payment.refunds.map((refund) => (
            <RefundLine key={refund.id} refund={refund} />
          ))}
        </ul>
      )}
      {payment.receiptNumber && (
        <details className="text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded font-medium text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            Receipt
          </summary>
          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt>Receipt number</dt>
            <dd className="font-mono text-foreground">{payment.receiptNumber}</dd>
            <dt>Order</dt>
            <dd className="font-mono text-foreground">{payment.orderId}</dd>
            <dt>Amount paid</dt>
            <dd className="text-foreground">{formatPaise(payment.amountPaise)}</dd>
            {payment.refundedPaise > 0 && (
              <>
                <dt>Refunded so far</dt>
                <dd className="text-foreground">{formatPaise(payment.refundedPaise)}</dd>
              </>
            )}
            {payment.paidAt && (
              <>
                <dt>Paid on</dt>
                <dd className="text-foreground">{formatDateTime(payment.paidAt)}</dd>
              </>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}
