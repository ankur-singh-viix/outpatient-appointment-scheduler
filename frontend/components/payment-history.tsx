'use client';

import { ReceiptIcon } from 'lucide-react';
import { Alert } from '@/components/common';
import { PaymentBadge, PaymentInfo } from '@/components/payment-info';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate, formatPaise, formatTime } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { PaymentHistoryItem, Session } from '@/lib/types';

/** Every payment the signed-in patient has made, with its receipt and any refunds, newest first. */
export function PaymentHistory({ session, reloadKey = 0 }: { session: Session; reloadKey?: number }) {
  const history = useQuery(`payments:${session.user.id}:${reloadKey}`, () =>
    api<PaymentHistoryItem[]>('/payments/mine', { token: session.accessToken }),
  );

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
  const items = history.data ?? history.previous;
  if (!items || items.length === 0) return null;

  return (
    <section aria-labelledby="payments-heading" className="space-y-3">
      <h2 id="payments-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <ReceiptIcon className="size-5 text-primary" aria-hidden />
        Payments and receipts
      </h2>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id}>
            <Card className="[--card-spacing:--spacing(4)]">
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-foreground">
                      {item.appointment.doctorName} · {formatDate(item.appointment.date, { weekday: 'short' })} at {formatTime(item.appointment.startTime)}
                    </p>
                    <p className="text-sm text-muted-foreground">{item.appointment.clinicName}</p>
                  </div>
                  <p className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{formatPaise(item.amountPaise)}</span>
                    <PaymentBadge status={item.displayStatus} />
                  </p>
                </div>
                <PaymentInfo payment={item} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
