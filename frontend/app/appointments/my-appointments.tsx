'use client';

import { CalendarCheckIcon, ClockIcon, MapPinIcon } from 'lucide-react';
import Link from 'next/link';
import { RequireRole } from '@/components/require-role';
import { Alert, EmptyState, Spinner, StatusBadge } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatDate, formatFee, formatTime, relativeDay } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import type { PatientAppointment, Session } from '@/lib/types';

export function MyAppointments() {
  return (
    <RequireRole role="PATIENT" nextPath="/appointments">
      {(session) => <AppointmentList session={session} />}
    </RequireRole>
  );
}

const byWhen = (a: PatientAppointment, b: PatientAppointment) =>
  `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`);

function AppointmentList({ session }: { session: Session }) {
  const today = useClinicToday();
  const appointments = useQuery(`mine:${session.user.id}`, () =>
    api<PatientAppointment[]>('/appointments/mine', { token: session.accessToken }),
  );

  if (appointments.loading) return <Spinner label="Loading your appointments…" />;
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
  const all = appointments.data ?? [];
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

  const upcoming = all.filter((a) => !today || a.date >= today).sort(byWhen);
  const past = all.filter((a) => today && a.date < today).sort((a, b) => byWhen(b, a));

  return (
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
          empty={<EmptyState title="No past appointments" icon={ClockIcon} />}
        />
      </TabsContent>
    </Tabs>
  );
}

function AppointmentGroup({
  items,
  today,
  empty,
}: {
  items: PatientAppointment[];
  today: string | null;
  empty: React.ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;
  return (
    <ul className="space-y-3">
      {items.map((a, index) => {
        const when = relativeDay(a.date, today);
        return (
          <li
            key={a.id}
            className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 fill-mode-backwards"
            style={{ animationDelay: `${Math.min(index, 5) * 40}ms` }}
          >
            <Card className="[--card-spacing:--spacing(4)]">
              <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div
                  className="flex w-16 shrink-0 flex-col items-center rounded-xl bg-accent py-2 text-accent-foreground"
                  aria-hidden
                >
                  <span className="text-xs font-semibold uppercase">
                    {formatDate(a.date, { weekday: undefined, day: undefined, year: undefined })}
                  </span>
                  <span className="text-2xl leading-none font-bold">{Number(a.date.slice(8))}</span>
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                    {formatDate(a.date, { weekday: 'long' })} · {formatTime(a.startTime)}
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
                </div>
                <StatusBadge status={a.status} />
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
