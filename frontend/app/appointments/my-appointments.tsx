'use client';

import Link from 'next/link';
import { RequireRole } from '@/components/require-role';
import { Alert, EmptyState, Spinner, StatusBadge } from '@/components/common';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate, formatFee, formatTime } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import type { PatientAppointment, Session } from '@/lib/types';

export function MyAppointments() {
  return (
    <RequireRole role="PATIENT" nextPath="/appointments">
      {(session) => <AppointmentList session={session} />}
    </RequireRole>
  );
}

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
      <EmptyState title="No appointments yet">
        <Link href="/" className={buttonVariants({ size: 'lg' })}>
          Find a doctor
        </Link>
      </EmptyState>
    );
  }

  const upcoming = all.filter((a) => !today || a.date >= today).reverse();
  const past = all.filter((a) => today && a.date < today);

  return (
    <div className="space-y-8">
      <AppointmentGroup title="Upcoming" items={upcoming} empty="No upcoming appointments." />
      {past.length > 0 && <AppointmentGroup title="Past" items={past} />}
    </div>
  );
}

function AppointmentGroup({ title, items, empty }: { title: string; items: PatientAppointment[]; empty?: string }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {items.length === 0 && empty && <p className="text-sm text-muted-foreground">{empty}</p>}
      <ul className="space-y-3">
        {items.map((a) => (
          <li key={a.id}>
            <Card>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-foreground">
                    {formatDate(a.date, { weekday: 'long' })} · {formatTime(a.startTime)}
                  </p>
                  <p className="text-sm text-foreground/80">
                    {a.doctor.name} · {a.doctor.specialty}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {a.clinic.name}, {a.clinic.address} · {formatFee(a.doctor.consultationFee)}
                  </p>
                </div>
                <StatusBadge status={a.status} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
