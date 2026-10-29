'use client';

import { CreditCardIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { openRazorpayCheckout } from '@/lib/razorpay';
import type { CheckoutDetails, PatientAppointment, Session } from '@/lib/types';

/** Whole seconds left on the hold; re-checked every second while there is one. */
function useSecondsLeft(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000)) : null;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * The payment step for a booking that is held but not yet paid. It opens Razorpay Checkout for the order the server created,
 * sends the result back to the server to be verified (the server, not this page, decides whether it was paid), and lets the
 * patient pay again or cancel. If the hold runs out the slot has already been given back.
 */
export function PaymentStep({
  appointment,
  checkout,
  session,
  autoOpen = false,
  onPaid,
  onCancelled,
  onExpired,
}: {
  appointment: PatientAppointment;
  /** Details from the booking response. Left out when coming back to an unpaid booking later: they are fetched fresh. */
  checkout?: CheckoutDetails;
  session: Session;
  /** Open the payment window straight away, as the page that just made the booking does. */
  autoOpen?: boolean;
  onPaid: () => void;
  onCancelled: () => void;
  onExpired?: () => void;
}) {
  const [busy, setBusy] = useState<'paying' | 'cancelling' | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const secondsLeft = useSecondsLeft(appointment.holdExpiresAt);
  const firstCheckout = useRef(checkout);
  const amount = formatPaise(checkout?.amountPaise ?? appointment.doctor.consultationFee * 100);

  const pay = async () => {
    setBusy('paying');
    setMessage(null);
    try {
      // The first open uses what the booking returned; any later one asks the server again, so it is always the live order.
      const details =
        firstCheckout.current ??
        (await api<CheckoutDetails>(`/payments/appointments/${appointment.id}/checkout`, { method: 'POST', token: session.accessToken }));
      firstCheckout.current = undefined;
      const result = await openRazorpayCheckout(details, { name: session.user.name, email: session.user.email }, (text) =>
        setMessage({ tone: 'error', text }),
      );
      if (result.outcome === 'dismissed') {
        setMessage({ tone: 'info', text: 'The payment window was closed. Your slot is still held: pay to confirm it.' });
        return;
      }
      await api('/payments/verify', {
        method: 'POST',
        token: session.accessToken,
        body: {
          razorpayOrderId: result.razorpayOrderId,
          razorpayPaymentId: result.razorpayPaymentId,
          razorpaySignature: result.razorpaySignature,
        },
      });
      onPaid();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) onExpired?.();
      setMessage({
        tone: 'error',
        text:
          error instanceof ApiError && error.status === 0
            ? 'We could not confirm your payment just now. If you were charged, your booking confirms automatically within a minute: refresh this page to check.'
            : errorMessage(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancelling');
    setMessage(null);
    try {
      await api(`/appointments/${appointment.id}/cancel`, { method: 'POST', token: session.accessToken, body: {} });
      onCancelled();
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) });
      setBusy(null);
    }
  };

  // The latest `pay` without making it an effect dependency (it is recreated on every render).
  const latestPay = useRef(pay);
  useEffect(() => {
    latestPay.current = pay;
  });
  const opened = useRef(false);
  useEffect(() => {
    if (autoOpen && !opened.current) {
      opened.current = true;
      void latestPay.current();
    }
  }, [autoOpen]);

  const lapsed = secondsLeft === 0;

  return (
    <section aria-label="Complete your payment" className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <CreditCardIcon className="size-4 text-primary" aria-hidden />
          Pay {amount} to confirm this appointment
        </p>
        {secondsLeft !== null && !lapsed && <p className="text-sm text-muted-foreground">Slot held for {clock(secondsLeft)}</p>}
      </div>
      {lapsed ? (
        <Alert tone="info">This booking was released because payment was not completed in time. Please choose a slot again.</Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your slot is reserved while you pay. If the payment is not completed in time it is released for other patients.
        </p>
      )}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <div className="flex flex-wrap gap-2">
        {!lapsed && (
          <Button size="lg" className="h-10" disabled={busy !== null} onClick={pay}>
            {busy === 'paying' ? 'Opening payment…' : `Pay ${amount}`}
          </Button>
        )}
        {lapsed ? (
          <Button size="lg" className="h-10" onClick={onExpired ?? onCancelled}>
            Choose another time
          </Button>
        ) : (
          <Button variant="outline" size="lg" className="h-10" disabled={busy !== null} onClick={cancel}>
            {busy === 'cancelling' ? 'Cancelling…' : 'Cancel booking'}
          </Button>
        )}
      </div>
    </section>
  );
}
