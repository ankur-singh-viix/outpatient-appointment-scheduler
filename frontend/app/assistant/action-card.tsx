'use client';

import { CheckCircle2Icon, HelpCircleIcon, ShieldCheckIcon, XCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/common';
import { PaymentStep } from '@/components/payment-step';
import { Button, buttonVariants } from '@/components/ui/button';
import { ApiError, api, errorMessage } from '@/lib/api';
import type { ActionCard, ActionResult, ActionStatus, PatientAppointment, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

type Stage =
  | { name: 'ready' }
  | { name: 'working'; what: 'confirm' | 'dismiss' }
  | { name: 'done'; message: string }
  | { name: 'payment'; result: ActionResult }
  | { name: 'ended'; tone: 'info' | 'error'; message: string }
  /** The server could not say for sure whether it went through. Nothing is repeated; the patient can ask again or look in My Appointments. */
  | { name: 'unsure'; message: string; checking: boolean };

/** Whole seconds until `iso`, re-checked every second while it is in the future. */
function useSecondsUntil(iso: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * The confirmation card for a booking, move or cancellation the assistant prepared. Nothing has happened when it appears. Pressing
 * Confirm asks the server to run exactly what it stored for this card (this page sends only the card's reference, nothing else), and
 * what is shown afterwards is what the server reports, never the assistant's own words. A booking that needs payment continues in the
 * existing secure payment window, and is called confirmed only after the server has verified the payment.
 */
export function ActionCardView({ card, session, onOutcome }: { card: ActionCard; session: Session; onOutcome: (message: string) => void }) {
  const [stage, setStage] = useState<Stage>({ name: 'ready' });
  const busy = useRef(false);
  const open = stage.name === 'ready';
  const secondsLeft = useSecondsUntil(card.expiresAt, open);
  const lapsed = open && secondsLeft === 0;

  const finish = (next: Stage, say?: string) => {
    setStage(next);
    if (say) onOutcome(say);
  };

  const confirm = async () => {
    if (busy.current || stage.name !== 'ready') return; // a double click or a second tab cannot send it twice from here
    busy.current = true;
    setStage({ name: 'working', what: 'confirm' });
    try {
      const result = await api<ActionResult>(`/assistant/actions/${card.ref}/confirm`, { method: 'POST', token: session.accessToken, body: {} });
      if (result.outcome === 'PAYMENT_REQUIRED' && result.checkout) setStage({ name: 'payment', result });
      else finish({ name: 'done', message: result.message }, result.message);
    } catch (error) {
      // The request may have reached the server and even finished: a lost connection, a server error, or an action the server says is
      // still running or uncertain. Never guess and never press again: ask the server what the records show.
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.code === 'ACTION_UNCERTAIN' || error.code === 'ACTION_IN_PROGRESS' || error.code === 'ACTION_ALREADY_DONE')) {
        busy.current = false;
        await checkStatus();
        return;
      }
      const text = errorMessage(error);
      const expired = error instanceof ApiError && error.status === 410;
      finish({ name: 'ended', tone: 'error', message: expired ? `${text} Nothing was changed.` : `${text} Nothing was changed. Ask me again if you still want this.` }, expired ? 'That confirmation expired, so nothing was changed.' : `It was not done: ${text}`);
    } finally {
      busy.current = false;
    }
  };

  /** Asks the server where this action really stands (it reconciles an interrupted one from the appointment data). */
  const checkStatus = async () => {
    setStage({ name: 'unsure', message: 'Checking what really happened…', checking: true });
    try {
      const found = await api<ActionStatus>(`/assistant/actions/${card.ref}`, { token: session.accessToken });
      if (found.state === 'DONE') {
        if (found.kind === 'BOOK' && found.appointment?.status === 'PENDING') {
          setStage({ name: 'payment', result: { kind: 'BOOK', outcome: 'PAYMENT_REQUIRED', message: found.message, appointment: found.appointment } });
          onOutcome(found.message);
        } else finish({ name: 'done', message: found.message }, found.message);
      } else if (found.state === 'PREPARED') setStage({ name: 'ready' }); // the request never reached the server: it is still waiting, so pressing again is safe
      else if (found.state === 'IN_PROGRESS' || found.state === 'UNCERTAIN') setStage({ name: 'unsure', message: found.message, checking: false });
      else finish({ name: 'ended', tone: found.state === 'NOT_APPLIED' || found.state === 'FAILED' ? 'error' : 'info', message: found.message }, found.state === 'DISMISSED' ? undefined : found.message);
    } catch (error) {
      setStage({ name: 'unsure', message: `We could not check just now (${errorMessage(error)}). Nothing has been repeated. Open My Appointments to see the real state.`, checking: false });
    }
  };

  const dismiss = async () => {
    if (busy.current || stage.name !== 'ready') return;
    busy.current = true;
    setStage({ name: 'working', what: 'dismiss' });
    try {
      await api(`/assistant/actions/${card.ref}/dismiss`, { method: 'POST', token: session.accessToken, body: {} });
      finish({ name: 'ended', tone: 'info', message: 'Cancelled. Nothing was changed.' }, 'Okay, I have not done anything.');
    } catch (error) {
      finish({ name: 'ended', tone: 'info', message: `${errorMessage(error)} Nothing was changed.` });
    } finally {
      busy.current = false;
    }
  };

  /** After the secure payment window: ask the server what really happened to the booking before saying anything. */
  const afterPayment = async (appointmentId: string) => {
    try {
      const mine = await api<PatientAppointment[]>('/appointments/mine', { token: session.accessToken });
      const found = mine.find((appointment) => appointment.id === appointmentId);
      if (found?.status === 'CONFIRMED') finish({ name: 'done', message: 'Payment verified. Your appointment is confirmed.' }, 'Payment verified and your appointment is confirmed.');
      else finish({ name: 'ended', tone: 'info', message: 'We have your payment, but the appointment is not confirmed yet. Open My Appointments in a minute to check.' }, 'I could not yet see the appointment as confirmed. Please check My Appointments in a minute.');
    } catch {
      finish({ name: 'ended', tone: 'info', message: 'We could not check the result just now. Open My Appointments to see whether the appointment is confirmed.' });
    }
  };

  if (stage.name === 'payment') {
    const held = stage.result.appointment;
    return (
      <div className="space-y-2 rounded-xl border bg-card p-3" aria-label="Payment for your booking">
        <Alert tone="info">{stage.result.message}</Alert>
        <PaymentStep
          appointment={held}
          checkout={stage.result.checkout}
          session={session}
          autoOpen
          onPaid={() => void afterPayment(held.id)}
          onCancelled={() => finish({ name: 'ended', tone: 'info', message: 'The booking was cancelled and the held slot released.' }, 'The held booking was cancelled.')}
          onExpired={() => finish({ name: 'ended', tone: 'error', message: 'The booking expired because payment was not completed in time. Ask me to book again.' }, 'The held booking expired before it was paid.')}
        />
      </div>
    );
  }

  return (
    <section aria-label={card.title} className={cn('space-y-3 rounded-xl border bg-card p-4 text-sm shadow-sm', stage.name === 'done' && 'border-emerald-300')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <ShieldCheckIcon className="size-4 text-primary" aria-hidden /> {card.title}
        </p>
        {open && !lapsed && <p className="text-xs text-muted-foreground">Expires in {clock(secondsLeft)}</p>}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {card.lines.map((line) => (
          <div key={line.label} className="contents">
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd className="font-medium text-foreground">{line.value}</dd>
          </div>
        ))}
      </dl>
      {card.note && <p className="text-xs text-muted-foreground">{card.note}</p>}

      {(stage.name === 'ready' || stage.name === 'working') && !lapsed && (
        <div className="flex flex-wrap gap-2">
          <Button size="lg" className="h-9" disabled={stage.name === 'working'} onClick={() => void confirm()}>
            {stage.name === 'working' && stage.what === 'confirm' ? 'Working…' : card.confirmLabel}
          </Button>
          <Button size="lg" variant="outline" className="h-9" disabled={stage.name === 'working'} onClick={() => void dismiss()}>
            {card.dismissLabel}
          </Button>
        </div>
      )}
      {lapsed && <Alert tone="info">This confirmation expired, so nothing was changed. Ask me again if you still want it.</Alert>}
      {stage.name === 'done' && (
        <p className="flex items-start gap-2 font-medium text-emerald-800" role="status">
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" aria-hidden /> {stage.message}
        </p>
      )}
      {stage.name === 'unsure' && (
        <div className="space-y-2" role="status">
          <p className="flex items-start gap-2 font-medium text-amber-800">
            <HelpCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden /> {stage.message}
          </p>
          {!stage.checking && (
            <div className="flex flex-wrap gap-2">
              <Button size="lg" variant="outline" className="h-9" onClick={() => void checkStatus()}>
                Check again
              </Button>
              <Link href="/appointments" className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-9' })}>
                Open My Appointments
              </Link>
            </div>
          )}
        </div>
      )}
      {stage.name === 'ended' && (
        <p className={cn('flex items-start gap-2 font-medium', stage.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')} role={stage.tone === 'error' ? 'alert' : 'status'}>
          <XCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden /> {stage.message}
        </p>
      )}
    </section>
  );
}
