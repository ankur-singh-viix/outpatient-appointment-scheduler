'use client';

import { CalendarCheckIcon, ClockIcon, MapPinIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { RequireRole } from '@/components/require-role';
import { Alert, EmptyState, Spinner, StatusBadge } from '@/components/common';
import { PaymentChip } from '@/components/payment-info';
import { PaymentStep } from '@/components/payment-step';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { canRemoveFromHistory, removableCancelled } from '@/lib/past-history';
import { ChooseNewTime } from './choose-new-time';
import { RemoveAllCancelled, RemoveFromHistory } from './remove-from-history';
import { VisitPrescriptionBlock } from './visit-prescription-block';
import { formatDate, formatFee, formatTimeRange, relativeDay } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import { queueApi } from '@/lib/queue-client';
import { appointmentQueueSummary } from '@/lib/queue-view';
import { cn } from '@/lib/utils';
import type { MyQueueEntry, PatientAppointment, PatientPrescription, PaymentsConfig, Session } from '@/lib/types';
import { Freshness, TokenBadge } from '../queue/queue-ui';
import { useQueuePolling } from '../queue/use-queue-polling';

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
  const prescriptions = useQuery(`prescriptions-mine:${session.user.id}`, () =>
    api<PatientPrescription[]>('/prescriptions/mine', { token: session.accessToken }),
  );
  const config = useQuery('payments-config', () => api<PaymentsConfig>('/payments/config'));
  // Live queue for today's visits only (own entries). Polls faster while waiting/serving.
  const queue = useQueuePolling<MyQueueEntry[]>(
    `appointments-queue-mine:${session.user.id}`,
    () => queueApi.mine(session),
    (latest) => {
      if (!latest || latest.length === 0) return 60_000;
      const live = latest.some((entry) => entry.status === 'WAITING' || entry.status === 'SERVING');
      return live ? 8_000 : 30_000;
    },
  );
  const queueByAppointment = useMemo(() => {
    const map = new Map<string, MyQueueEntry>();
    for (const entry of queue.data ?? []) map.set(entry.appointmentId, entry);
    return map;
  }, [queue.data]);
  const prescriptionByAppointment = useMemo(() => {
    const map = new Map<string, PatientPrescription>();
    for (const row of prescriptions.data ?? []) map.set(row.appointmentId, row);
    return map;
  }, [prescriptions.data]);

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

  // Upcoming = still-active future bookings. Completed = genuine COMPLETED visits only.
  // Other = cancelled, no-show, and any leftover non-upcoming rows (never mixed into Completed).
  const upcoming = all.filter((a) => isActive(a) && (!today || a.date >= today)).sort(byWhen);
  const completed = all.filter((a) => a.status === 'COMPLETED').sort((a, b) => byWhen(b, a));
  const other = all.filter((a) => !upcoming.includes(a) && a.status !== 'COMPLETED').sort((a, b) => byWhen(b, a));

  return (
    <div className="space-y-4">
      {notice && <Alert tone="success">{notice}</Alert>}
      {queue.data && (
        <Freshness updatedAt={queue.updatedAt} stale={queue.stale} error={queue.error} onRetry={() => void queue.refresh()} />
      )}
      <Tabs defaultValue="upcoming" className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-b">
          <TabsTrigger value="upcoming" className="flex-none px-4">
            Upcoming ({upcoming.length})
          </TabsTrigger>
          <TabsTrigger value="completed" className="flex-none px-4">
            Completed ({completed.length})
          </TabsTrigger>
          <TabsTrigger value="other" className="flex-none px-4">
            Cancelled & other ({other.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="upcoming">
          <AppointmentGroup
            items={upcoming}
            today={today}
            session={session}
            policy={config.data ?? null}
            queueByAppointment={queueByAppointment}
            onCancelled={() => {
              setNotice('Appointment cancelled. The slot is now free for other patients.');
              appointments.reload();
              void queue.refresh();
            }}
            onPaid={() => {
              setNotice('Payment received. Your appointment is confirmed.');
              appointments.reload();
              void queue.refresh();
            }}
            onMoved={() => {
              setNotice('Your appointment has been moved to the new time. Your booking and any payment came with it.');
              appointments.reload();
              void queue.refresh();
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
        <TabsContent value="completed">
          {prescriptions.error && (
            <div className="mb-3">
              <Alert
                action={
                  <Button size="sm" variant="outline" onClick={prescriptions.reload}>
                    Try again
                  </Button>
                }
              >
                Could not load prescriptions. {prescriptions.error}
              </Alert>
            </div>
          )}
          <AppointmentGroup
            items={completed}
            today={today}
            session={session}
            queueByAppointment={queueByAppointment}
            prescriptionByAppointment={prescriptionByAppointment}
            showPrescription
            onRemoved={(message) => {
              setNotice(message);
              appointments.reload();
            }}
            empty={
              <EmptyState title="No completed visits yet" icon={ClockIcon}>
                <p>After a consultation finishes, the visit and any finalized prescription appear here.</p>
              </EmptyState>
            }
          />
        </TabsContent>
        <TabsContent value="other">
          {removableCancelled(other).length > 1 && (
            <div className="mb-3 flex justify-end">
              <RemoveAllCancelled
                ids={removableCancelled(other)}
                session={session}
                onDone={(message) => {
                  setNotice(message);
                  appointments.reload();
                }}
              />
            </div>
          )}
          <AppointmentGroup
            items={other}
            today={today}
            session={session}
            queueByAppointment={queueByAppointment}
            onRemoved={(message) => {
              setNotice(message);
              appointments.reload();
            }}
            empty={<EmptyState title="No cancelled or other past appointments" icon={ClockIcon} />}
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
  queueByAppointment,
  prescriptionByAppointment,
  showPrescription = false,
  onCancelled,
  onPaid,
  onMoved,
  onRemoved,
  empty,
}: {
  items: PatientAppointment[];
  today: string | null;
  session: Session;
  policy?: PaymentsConfig | null;
  queueByAppointment: Map<string, MyQueueEntry>;
  prescriptionByAppointment?: Map<string, PatientPrescription>;
  showPrescription?: boolean;
  onCancelled?: () => void;
  onPaid?: () => void;
  onMoved?: () => void;
  onRemoved?: (message: string) => void;
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
          <AppointmentCard
            appointment={a}
            today={today}
            session={session}
            policy={policy}
            queueEntry={queueByAppointment.get(a.id) ?? null}
            prescription={showPrescription ? (prescriptionByAppointment?.get(a.id) ?? null) : undefined}
            onCancelled={onCancelled}
            onPaid={onPaid}
            onMoved={onMoved}
            onRemoved={onRemoved}
          />
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
  queueEntry,
  prescription,
  onCancelled,
  onPaid,
  onMoved,
  onRemoved,
}: {
  appointment: PatientAppointment;
  today: string | null;
  session: Session;
  policy?: PaymentsConfig | null;
  queueEntry: MyQueueEntry | null;
  /** When set (including null), show the visit prescription block for completed visits. */
  prescription?: PatientPrescription | null;
  onCancelled?: () => void;
  onPaid?: () => void;
  onMoved?: () => void;
  onRemoved?: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = isActive(a) ? relativeDay(a.date, today) : null;
  const cancelled = a.status === 'CANCELLED';
  // Prefer the booking token from the appointment; fall back to the live queue row (same number).
  const token = a.queueToken ?? queueEntry?.token ?? null;
  const queueSummary = appointmentQueueSummary({ status: a.status, queueToken: token }, queueEntry);
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

        {token != null && queueSummary && (
          <div
            className="flex flex-col gap-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 sm:flex-row sm:items-center sm:gap-6"
            aria-label={`Queue token ${token}`}
          >
            <div className="flex shrink-0 flex-col items-center gap-1 sm:items-start">
              <p className="text-xs font-semibold tracking-[0.2em] text-emerald-900 uppercase">Token</p>
              <TokenBadge token={token} size="xl" className="bg-emerald-700 shadow-sm" />
            </div>
            <div className="min-w-0 flex-1 space-y-2" aria-live="polite">
              <p className="text-sm font-semibold text-emerald-950">{queueSummary.statusLabel}</p>
              {queueSummary.showLivePosition && (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  {queueSummary.positionOrdinal && (
                    <p className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                      {queueSummary.positionOrdinal}
                      <span className="ml-2 text-sm font-medium text-muted-foreground">in queue</span>
                    </p>
                  )}
                  {queueSummary.aheadLabel && (
                    <p className="text-base font-medium text-foreground/80">{queueSummary.aheadLabel}</p>
                  )}
                </div>
              )}
              <p className="text-sm text-emerald-950/90">{queueSummary.headline}</p>
            </div>
          </div>
        )}

        {a.status === 'PENDING' && a.holdExpiresAt && onCancelled && (
          <PaymentStep appointment={a} session={session} onPaid={() => onPaid?.()} onCancelled={onCancelled} onExpired={onCancelled} />
        )}

        {a.payment && a.payment.displayStatus !== 'EXPIRED' && a.payment.displayStatus !== 'PAYMENT_PENDING' && (
          <div className="border-t pt-4">
            <PaymentChip payment={a.payment} />
          </div>
        )}

        {prescription !== undefined && <VisitPrescriptionBlock prescription={prescription} />}

        {cancelled && a.cancelledBy === 'DOCTOR' && today && a.date >= today && (
          <div className="border-t pt-4">
            <Link href={`/doctors/${a.doctor.id}`} className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-9' })}>
              Book another time
            </Link>
          </div>
        )}

        {onRemoved && canRemoveFromHistory(a) && (
          <div className="border-t pt-4">
            <RemoveFromHistory appointment={a} session={session} onRemoved={onRemoved} />
          </div>
        )}

        {changeable && a.needsNewTime && !confirming && (
          <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="note">
            <p className="font-semibold">{a.doctor.name} changed their hours</p>
            <p>
              This time is no longer within them. Your appointment is still booked. Choose a new time to move it; you will be asked to confirm, and nothing changes unless you do.
            </p>
          </div>
        )}

        {changeable && a.needsNewTime && choosing && !confirming && (
          <ChooseNewTime
            appointment={a}
            session={session}
            onClose={() => setChoosing(false)}
            onMoved={() => {
              setChoosing(false);
              onMoved?.();
            }}
          />
        )}

        {changeable && !confirming && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {a.needsNewTime ? (
              <Button
                variant="default"
                size="lg"
                className="h-9"
                aria-expanded={choosing}
                aria-label={`Choose a new time for the appointment with ${a.doctor.name} on ${formatDate(a.date, { weekday: 'long' })}`}
                onClick={() => setChoosing((current) => !current)}
              >
                Choose a new time
              </Button>
            ) : (
              <Link
                href={`/doctors/${a.doctor.id}?reschedule=${a.id}`}
                aria-label={`Reschedule appointment with ${a.doctor.name} on ${formatDate(a.date, { weekday: 'long' })}`}
                className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-9' })}
              >
                Reschedule
              </Link>
            )}
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
