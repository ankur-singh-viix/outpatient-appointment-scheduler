'use client';

import { useState } from 'react';
import { Alert, EmptyState, Spinner, StatusBadge } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import type { DoctorAppointment, DoctorAvailability, Session } from '@/lib/types';
import { DateOverridesEditor, WeeklyHoursEditor } from './availability-editor';

export function DoctorDashboard() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor">
      {(session) => <Dashboard session={session} />}
    </RequireRole>
  );
}

function Dashboard({ session }: { session: Session }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{session.user.name}</h1>
        <p className="text-sm text-muted-foreground">Doctor dashboard</p>
      </div>
      <Tabs defaultValue="appointments" className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-b">
          <TabsTrigger value="appointments" className="flex-none px-4 capitalize">
            appointments
          </TabsTrigger>
          <TabsTrigger value="availability" className="flex-none px-4 capitalize">
            availability
          </TabsTrigger>
        </TabsList>
        <TabsContent value="appointments" className="text-base">
          <Appointments session={session} />
        </TabsContent>
        <TabsContent value="availability" className="text-base">
          <Availability session={session} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Appointments({ session }: { session: Session }) {
  const [scope, setScope] = useState<'upcoming' | 'all'>('upcoming');
  const today = useClinicToday();
  const appointments = useQuery(`doctor-appointments:${session.user.id}:${scope}`, () =>
    api<DoctorAppointment[]>(`/doctor-portal/appointments?scope=${scope}`, { token: session.accessToken }),
  );
  const list = appointments.data ?? [];
  const active = list.filter((a) => a.status === 'CONFIRMED' || a.status === 'PENDING');
  const byDate = new Map<string, DoctorAppointment[]>();
  for (const a of list) byDate.set(a.date, [...(byDate.get(a.date) ?? []), a]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Today" value={today ? active.filter((a) => a.date === today).length : '–'} />
        <Stat label={scope === 'upcoming' ? 'Upcoming' : 'All bookings'} value={appointments.data ? active.length : '–'} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex gap-1 rounded-lg border bg-card p-0.5" role="group" aria-label="Show">
          {(['upcoming', 'all'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={scope === s ? 'default' : 'ghost'}
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className="capitalize"
            >
              {s}
            </Button>
          ))}
        </div>
        <Button variant="outline" onClick={appointments.reload} disabled={appointments.loading}>
          {appointments.loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {appointments.loading && <Spinner label="Loading appointments…" />}
      {appointments.error && <Alert>{appointments.error}</Alert>}
      {appointments.data && list.length === 0 && (
        <EmptyState title={scope === 'upcoming' ? 'No upcoming appointments' : 'No appointments yet'}>
          New bookings from patients will appear here.
        </EmptyState>
      )}

      {[...byDate.entries()].map(([date, items]) => (
        <section key={date} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {formatDate(date, { weekday: 'long' })}
            {date === today && <Badge variant="secondary">Today</Badge>}
          </h2>
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Time</TableHead>
                  <TableHead className="px-4">Patient</TableHead>
                  <TableHead className="px-4">Phone</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="px-4 py-3 font-medium whitespace-nowrap">
                      {formatTime(a.startTime)} – {formatTime(a.endTime)}
                    </TableCell>
                    <TableCell className="px-4 py-3">{a.patient.name}</TableCell>
                    <TableCell className="px-4 py-3 whitespace-nowrap text-muted-foreground">{a.patient.phone ?? '—'}</TableCell>
                    <TableCell className="px-4 py-3">
                      <StatusBadge status={a.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

function Availability({ session }: { session: Session }) {
  const availability = useQuery(`availability:${session.user.id}`, () =>
    api<DoctorAvailability>('/doctor-portal/availability', { token: session.accessToken }),
  );

  if (availability.loading && !availability.previous) return <Spinner label="Loading availability…" />;
  if (availability.error) return <Alert>{availability.error}</Alert>;
  const data = availability.data ?? availability.previous;
  if (!data) return null;
  const onSaved = availability.reload;

  return (
    <div className="space-y-6">
      {/* The editor keeps its own form state; the key remounts it when the saved hours change. */}
      <WeeklyHoursEditor key={JSON.stringify(data.weekly)} session={session} availability={data} onSaved={onSaved} />
      <DateOverridesEditor session={session} availability={data} onSaved={onSaved} />
    </div>
  );
}
