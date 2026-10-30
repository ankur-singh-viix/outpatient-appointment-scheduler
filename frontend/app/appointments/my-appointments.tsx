'use client';

import { CalendarCheckIcon, ClockIcon, MapPinIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { RequireRole } from '@/components/require-role';
import { Alert, EmptyState, Spinner, StatusBadge } from '@/components/common';
import { PaymentChip } from '@/components/payment-info';
import { PaymentStep } from '@/components/payment-step';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatFee, formatTimeRange, relativeDay } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { PatientAppointment, PaymentsConfig, Session } from '@/lib/types';

export function MyAppointments() {
  return (
    <RequireRole role="PATIENT" nextPath="/appointments">
      {(session) => <AppointmentList session={session} />}
    </RequireRole>
  );
}

const byWhen = (a: PatientAppointment, b: PatientAppointment) =>
  `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`);

const isActive = (a: PatientAppointment) => a.status === 'CONFIRMED' || a.status === 'PENDING';

function AppointmentList({ session }: { session: Session }) {
  const today = useClinicToday();
  const [notice, setNotice] = useState<string | null>(null);
  const appointments = useQuery(`mine:${session.user.id}`, () =>
    api<PatientAppointment[]>('/appointments/mine', { token: session.accessToken }),
  );
  const config = useQuery('payments-config', () => api<PaymentsConfig>('/payments/config'));

  // Keep showing the list while it refreshes after a cancellation.
  const data = appointments.data ?? appointments.previous;
  if (!data && appointments.loading) return <Spinner label="Loading your appointments…" />;
  if (appointments.error) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={appointments.reload}>
            Try again
          </Button>
        }
      >
        {appointments.error}
      </Alert>
    );
  }
  const all = data ?? [];
  if (all.length === 0) {
    return (
      <EmptyState title="No appointments yet" icon={CalendarCheckIcon}>
        <p>When you book a visit it will show up here.</p>
        <Link href="/" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
          Find a doctor
        </Link>
      </EmptyState>
    );
  }

  // Cancelled appointments (including ones replaced by a reschedule) live under Past as a record.
  const upcoming = all.filter((a) => isActive(a) && (!today || a.date >= today)).sort(byWhen);
  const past = all.filter((a) => !upcoming.includes(a)).sort((a, b) => byWhen(b, a));

  return (
    <div className="space-y-4">
      {notice && <Alert tone="success">{notice}</Alert>}
      <Tabs defaultValue="upcoming" className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-b">
          <TabsTrigger value="upcoming" className="flex-none px-4">
            Upcoming ({upcoming.length})
          </TabsTrigger>
          <TabsTrigger value="past" className="flex-none px-4">
            Past ({past.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="upcoming">
          <AppointmentGroup
            items={upcoming}
            today={today}
            session={session}
            policy={config.data ?? null}
            onCancelled={() => {
              setNotice('Appointment cancelled. The slot is now free for other patients.');
              appointments.reload();
            }}
            onPaid={() => {
              setNotice('Payment received. Your appointment is confirmed.');
              appointments.reload();
            }}
            empty={
              <EmptyState title="No upcoming appointments" icon={CalendarCheckIcon}>
                <Link href="/" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
                  Book an appointment
                </Link>
              </EmptyState>
            }
          />
        </TabsContent>
        <TabsContent value="past">
          <AppointmentGroup
            items={past}
            today={today}
            session={session}
            empty={<EmptyState title="No past appointments" icon={ClockIcon} />}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AppointmentGroup({
  items,
  today,
  session,
  policy = null,
  onCancelled,
  onPaid,
  empty,
}: {
  items: PatientAppointment[];
  today: string | null;
  session: Session;
  policy?: PaymentsConfig | null;
  onCancelled?: () => void;
  onPaid?: () => void;
  empty: React.ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;
  return (
    <ul className="space-y-3">
      {items.map((a, index) => (
        <li
          key={a.id}
          className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 fill-mode-backwards"
          style={{ animationDelay: `${Math.min(index, 5) * 40}ms` }}
        >
          <AppointmentCard appointment={a} today={today} session={session} policy={policy} onCancelled={onCancelled} onPaid={onPaid} />
        </li>
      ))}
    </ul>
  );
}

function AppointmentCard({
  appointment: a,
  today,
  session,
  policy,
  onCancelled,
  onPaid,
}: {
  appointment: PatientAppointment;
  today: string | null;
  session: Session;
  policy: PaymentsConfig | null;
  onCancelled?: () => void;
  onPaid?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = isActive(a) ? relativeDay(a.date, today) : null;
  const cancelled = a.status === 'CANCELLED';
  // The buttons only appear on confirmed upcoming appointments (the server also refuses changes to anything else).
  // A booking still waiting for payment has its own Pay / Cancel buttons instead.
  const changeable = Boolean(onCancelled) && a.status === 'CONFIRMED';

  const cancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await api(`/appointments/${a.id}/cancel`, { method: 'POST', token: session.accessToken, body: {} });
      onCancelled?.();
    } catch (err) {
      setError(errorMessage(err));
      setCancelling(false);
    }
  };

  return (
    <Card className="[--card-spacing:--spacing(4)]">
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div
            className={cn(
              'flex w-16 shrink-0 flex-col items-center rounded-xl bg-accent py-2 text-accent-foreground',
              cancelled && 'bg-muted text-muted-foreground',
            )}
            aria-hidden
          >
            <span className="text-xs font-semibold uppercase">
              {formatDate(a.date, { weekday: undefined, day: undefined, year: undefined })}
            </span>
            <span className="text-2xl leading-none font-bold">{Number(a.date.slice(8))}</span>
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <p className={cn('flex flex-wrap items-center gap-2 font-semibold text-foreground', cancelled && 'text-muted-foreground')}>
              {formatDate(a.date, { weekday: 'long' })} · {formatTimeRange(a.startTime, a.endTime)}
              {when && (
                <Badge variant="secondary" className="bg-primary/10 text-primary">
                  {when}
                </Badge>
              )}
            </p>
            <p className="text-sm text-foreground/80">
              {a.doctor.name} · {a.doctor.specialty}
            </p>
            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <MapPinIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {a.clinic.name}, {a.clinic.address} · {formatFee(a.doctor.consultationFee)}
            </p>
            {cancelled && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {a.cancelledBy === 'DOCTOR' ? 'Cancelled by your doctor' : a.cancelledBy === 'PATIENT' ? 'Cancelled by you' : 'Cancelled'}
                </span>
                {a.cancelReason && <> · Reason: {a.cancelReason}</>}
              </p>
            )}
          </div>
          <StatusBadge status={a.status} />
        </div>

        {a.status === 'PENDING' && a.holdExpiresAt && onCancelled && (
          <PaymentStep appointment={a} session={session} onPaid={() => onPaid?.()} onCancelled={onCancelled} onExpired={onCancelled} />
        )}

        {a.payment && a.payment.displayStatus !== 'EXPIRED' && a.payment.displayStatus !== 'PAYMENT_PENDING' && (
          <div className="border-t pt-4">
            <PaymentChip payment={a.payment} />
          </div>
        )}

        {cancelled && a.cancelledBy === 'DOCTOR' && today && a.date >= today && (
          <div className="border-t pt-4">
            <Link href={`/doctors/${a.doctor.id}`} className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-9' })}>
              Book another time
            </Link>
          </div>
        )}

        {changeable && !confirming && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Link
              href={`/doctors/${a.doctor.id}?reschedule=${a.id}`}
              aria-label={`Reschedule appointment with ${a.doctor.name} on ${formatDate(a.date, { weekday: 'long' })}`}
              className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-9' })}
            >
              Reschedule
            </Link>
            <Button
              variant="destructive"
              size="lg"
              className="h-9"
              aria-label={`Cancel appointment with ${a.doctor.name} on ${formatDate(a.date, { weekday: 'long' })}`}
              onClick={() => setConfirming(true)}
            >
              Cancel appointment
            </Button>
          </div>
        )}

        {changeable && confirming && (
          <div className="space-y-3 border-t pt-4" role="group" aria-label="Confirm cancellation">
            <p className="text-sm font-medium text-foreground">
              Cancel this appointment? The slot will be released for other patients.
            </p>
            {a.payment?.displayStatus === 'PAID' && policy?.enabled && (
              <p className="text-sm text-muted-foreground">
                Refunds: full if you cancel at least {policy.refundPolicy.fullRefundHoursBefore} hours before the appointment
                {policy.refundPolicy.partialRefundPercent > 0 && (
                  <>
                    , {policy.refundPolicy.partialRefundPercent}% if at least {policy.refundPolicy.partialRefundHoursBefore} hours before,
                  </>
                )}{' '}
                and none after that. If your doctor cancels, you always get a full refund.
              </p>
            )}
            {error && <Alert>{error}</Alert>}
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" size="lg" className="h-9" disabled={cancelling} onClick={cancel}>
                {cancelling ? 'Cancelling…' : 'Yes, cancel appointment'}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="h-9"
                disabled={cancelling}
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
              >
                Keep appointment
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
