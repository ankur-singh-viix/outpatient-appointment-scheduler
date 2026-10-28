'use client';

import { ArrowRightIcon, CalendarCheckIcon, CalendarClockIcon, CalendarPlusIcon, UserRoundIcon } from 'lucide-react';
import Link from 'next/link';
import { Alert, EmptyState, PageHeader, StatusBadge } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { clinicClock, formatDate, formatTime, relativeDay, timeAgo } from '@/lib/format';
import { useAutoRefresh, useClinicToday, useNow, useQuery } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { DoctorAppointment, Session } from '@/lib/types';

const NEW_BOOKING_MS = 24 * 60 * 60 * 1000;
const isActive = (a: DoctorAppointment) => a.status === 'CONFIRMED' || a.status === 'PENDING';

export function DoctorDashboard() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor">
      {(session) => <Overview session={session} />}
    </RequireRole>
  );
}

const SHORTCUTS = [
  { href: '/doctor/appointments', title: 'Appointments', text: 'Your schedule by day, with cancellations.', icon: CalendarCheckIcon },
  { href: '/doctor/availability', title: 'Availability', text: 'Weekly sessions, capacity and slot length.', icon: CalendarClockIcon },
  { href: '/doctor/profile', title: 'Profile', text: 'Your public details and consultation fee.', icon: UserRoundIcon },
];

function Overview({ session }: { session: Session }) {
  const today = useClinicToday();
  const now = useNow();
  const appointments = useQuery(`doctor-overview:${session.user.id}`, () =>
    api<DoctorAppointment[]>('/doctor-portal/appointments?scope=upcoming', { token: session.accessToken }),
  );
  useAutoRefresh(appointments.reload);

  const list = appointments.data ?? appointments.previous;
  const active = (list ?? []).filter(isActive);
  const clock = clinicClock(now);
  const todays = today ? active.filter((a) => a.date === today) : [];
  const upcoming = today ? active.filter((a) => a.date >= today) : [];
  const newlyBooked = upcoming.filter((a) => now - Date.parse(a.bookedAt) < NEW_BOOKING_MS);
  // The API returns them in date and time order, so the first one that has not started yet is the next one.
  const next = upcoming.find((a) => a.date > clock.date || (a.date === clock.date && a.startTime > clock.time));

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-300">
      <PageHeader title={`Welcome back, ${session.user.name}`} description="Your schedule at a glance." />

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

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Today" value={list ? todays.length : '–'} />
        <Stat label="Upcoming" value={list ? upcoming.length : '–'} />
        <Stat label="New (24 h)" value={list ? newlyBooked.length : '–'} highlight={newlyBooked.length > 0} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="today-heading" className="space-y-3">
          <h2 id="today-heading" className="text-lg font-semibold text-foreground">
            Today&apos;s appointments
          </h2>
          {!list && appointments.loading && (
            <Card aria-hidden>
              <CardContent className="space-y-3">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </CardContent>
            </Card>
          )}
          {list && todays.length === 0 && (
            <EmptyState title="No appointments today" icon={CalendarPlusIcon}>
              New bookings from patients appear here automatically.
            </EmptyState>
          )}
          {todays.length > 0 && (
            <Card className="py-0">
              <ul className="divide-y">
                {todays.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                    <p className="w-24 shrink-0 font-semibold text-foreground">{formatTime(a.startTime)}</p>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">{a.patient.name}</p>
                      <p className="text-sm text-muted-foreground">Booked {timeAgo(a.bookedAt, now)}</p>
                    </div>
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Link href="/doctor/appointments" className={cn(buttonVariants({ variant: 'ghost', size: 'lg' }), 'gap-1.5')}>
            All appointments
            <ArrowRightIcon aria-hidden />
          </Link>
        </section>

        <div className="space-y-6">
          <section aria-labelledby="next-heading" className="space-y-3">
            <h2 id="next-heading" className="text-lg font-semibold text-foreground">
              Next appointment
            </h2>
            {list && !next ? (
              <p className="rounded-xl border border-dashed bg-card p-4 text-sm text-muted-foreground">Nothing coming up yet.</p>
            ) : next ? (
              <Card className="[--card-spacing:--spacing(4)]">
                <CardContent className="space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                    {formatDate(next.date, { weekday: 'long' })} · {formatTime(next.startTime)}
                    {relativeDay(next.date, today) && (
                      <Badge variant="secondary" className="bg-primary/10 text-primary">
                        {relativeDay(next.date, today)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-foreground/80">{next.patient.name}</p>
                  {next.patient.phone && <p className="text-sm text-muted-foreground">{next.patient.phone}</p>}
                </CardContent>
              </Card>
            ) : (
              <Skeleton className="h-20" aria-hidden />
            )}
          </section>

          <section aria-labelledby="shortcuts-heading" className="space-y-3">
            <h2 id="shortcuts-heading" className="text-lg font-semibold text-foreground">
              Manage
            </h2>
            <ul className="space-y-2">
              {SHORTCUTS.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="flex items-center gap-3 rounded-xl border bg-card p-3 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground" aria-hidden>
                      <item.icon className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground">{item.title}</span>
                      <span className="block text-sm text-muted-foreground">{item.text}</span>
                    </span>
                    <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <Card className={cn('[--card-spacing:--spacing(4)]', highlight && 'ring-primary/40')}>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-bold', highlight ? 'text-primary' : 'text-foreground')}>{value}</p>
      </CardContent>
    </Card>
  );
}
