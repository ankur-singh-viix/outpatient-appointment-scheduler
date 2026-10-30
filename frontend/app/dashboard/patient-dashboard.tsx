'use client';

import { ArrowRightIcon, CalendarCheckIcon, CalendarPlusIcon, ClockIcon, MapPinIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { Alert, EmptyState, PageHeader, StatusBadge } from '@/components/common';
import { PaymentChip } from '@/components/payment-info';
import { PaymentStep } from '@/components/payment-step';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDate, formatFee, formatTimeRange, relativeDay } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import type { PatientAppointment, Session } from '@/lib/types';

export function PatientDashboard() {
  return (
    <RequireRole role="PATIENT" nextPath="/dashboard">
      {(session) => <Dashboard session={session} />}
    </RequireRole>
  );
}

const isActive = (a: PatientAppointment) => a.status === 'CONFIRMED' || a.status === 'PENDING';
const byWhen = (a: PatientAppointment, b: PatientAppointment) =>
  `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`);

function Dashboard({ session }: { session: Session }) {
  const today = useClinicToday();
  const appointments = useQuery(`dashboard:${session.user.id}`, () =>
    api<PatientAppointment[]>('/appointments/mine', { token: session.accessToken }),
  );

  const all = appointments.data ?? [];
  const upcoming = all.filter((a) => isActive(a) && today && a.date >= today).sort(byWhen);
  const next = upcoming[0];
  const visits = all.filter((a) => isActive(a) && today && a.date < today).length;
  const cancelled = all.filter((a) => a.status === 'CANCELLED').length;
  // Visits the doctor cancelled that would still have been ahead: the patient needs to know and rebook.
  const doctorCancelled = all
    .filter((a) => a.status === 'CANCELLED' && a.cancelledBy === 'DOCTOR' && today && a.date >= today)
    .sort(byWhen);
  const firstName = session.user.name.split(' ')[0];

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-300">
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description="Your upcoming care and quick ways to book the next visit."
      />

      <Card className="bg-gradient-to-br from-teal-700 to-teal-900 text-white [--card-spacing:--spacing(6)]">
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-widest text-teal-200 uppercase">Ready when you are</p>
            <h2 className="mt-1 text-xl font-bold">Book an appointment</h2>
            <p className="mt-1 text-sm text-teal-50">Search by doctor or specialty and pick a time that suits you.</p>
          </div>
          <Link href="/" className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'h-10 gap-2' })}>
            <SearchIcon aria-hidden />
            Find a doctor
          </Link>
        </CardContent>
      </Card>

      {doctorCancelled.map((a) => (
        <Alert key={a.id}>
          {a.doctor.name} cancelled your appointment on {formatDate(a.date, { weekday: 'long' })}, {formatTimeRange(a.startTime, a.endTime)}.
          {a.cancelReason && <> Reason: {a.cancelReason}</>} ·{' '}
          <Link href={`/doctors/${a.doctor.id}`} className="font-semibold underline underline-offset-2">
            Book another time
          </Link>
        </Alert>
      ))}

      <section aria-labelledby="next-heading" className="space-y-3">
        <h2 id="next-heading" className="text-lg font-semibold text-foreground">
          Next appointment
        </h2>

        {appointments.error && (
          <Alert
            action={
              <Button size="sm" variant="outline" onClick={appointments.reload}>
                Try again
              </Button>
            }
          >
            Could not load your appointments. {appointments.error}
          </Alert>
        )}

        {appointments.loading && !appointments.data && (
          <Card aria-hidden>
            <CardContent className="space-y-3">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
        )}

        {appointments.data && !next && (
          <EmptyState title="No upcoming appointments" icon={CalendarPlusIcon}>
            <p>When you book a visit, it will appear here with quick ways to change it.</p>
            <Link href="/" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
              Book an appointment
            </Link>
          </EmptyState>
        )}

        {next && (
          <Card className="[--card-spacing:--spacing(5)]">
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="flex w-16 shrink-0 flex-col items-center rounded-xl bg-accent py-2 text-accent-foreground" aria-hidden>
                  <span className="text-xs font-semibold uppercase">{formatDate(next.date, { weekday: undefined, day: undefined, year: undefined })}</span>
                  <span className="text-2xl leading-none font-bold">{Number(next.date.slice(8))}</span>
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                    {formatDate(next.date, { weekday: 'long' })} · {formatTimeRange(next.startTime, next.endTime)}
                    {relativeDay(next.date, today) && (
                      <Badge variant="secondary" className="bg-primary/10 text-primary">
                        {relativeDay(next.date, today)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-foreground/80">
                    {next.doctor.name} · {next.doctor.specialty}
                  </p>
                  <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                    <MapPinIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {next.clinic.name}, {next.clinic.address} · {formatFee(next.doctor.consultationFee)}
                  </p>
                </div>
                <StatusBadge status={next.status} />
              </div>
              {next.status === 'PENDING' && next.holdExpiresAt && (
                <PaymentStep appointment={next} session={session} onPaid={appointments.reload} onCancelled={appointments.reload} onExpired={appointments.reload} />
              )}
              {next.payment && <PaymentChip payment={next.payment} />}
              <div className="flex flex-wrap gap-2 border-t pt-4">
                {next.status === 'CONFIRMED' && (
                  <Link
                    href={`/doctors/${next.doctor.id}?reschedule=${next.id}`}
                    className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-9' })}
                  >
                    Reschedule
                  </Link>
                )}
                <Link href="/appointments" className={buttonVariants({ variant: 'ghost', size: 'lg', className: 'h-9 gap-1.5' })}>
                  All appointments
                  <ArrowRightIcon aria-hidden />
                </Link>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="summary-heading" className="space-y-3">
        <h2 id="summary-heading" className="text-lg font-semibold text-foreground">
          Your appointments at a glance
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat icon={<CalendarCheckIcon className="size-4" aria-hidden />} label="Upcoming" value={appointments.data ? upcoming.length : '–'} />
          <Stat icon={<ClockIcon className="size-4" aria-hidden />} label="Past visits" value={appointments.data ? visits : '–'} />
          <Stat icon={<CalendarPlusIcon className="size-4" aria-hidden />} label="Cancelled" value={appointments.data ? cancelled : '–'} />
        </div>
      </section>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
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
