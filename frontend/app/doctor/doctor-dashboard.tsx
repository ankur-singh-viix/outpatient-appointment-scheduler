'use client';

import { CalendarCheckIcon, CalendarPlusIcon, ChevronLeftIcon, ChevronRightIcon, PhoneIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, EmptyState, PageHeader, Spinner, StatusBadge } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { addDays, dayOfWeek, DAY_SHORT, formatDate, formatTime, relativeDay, timeAgo } from '@/lib/format';
import { useClinicToday, useNow, useQuery } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { DoctorAppointment, DoctorAvailability, Session } from '@/lib/types';
import { DateOverridesEditor, WeeklyHoursEditor } from './availability-editor';

const REFRESH_MS = 30_000;
const NEW_BOOKING_MS = 24 * 60 * 60 * 1000;

export function DoctorDashboard() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor">
      {(session) => <Dashboard session={session} />}
    </RequireRole>
  );
}

function Dashboard({ session }: { session: Session }) {
  return (
    <div className="animate-in fade-in-0 duration-300">
      <PageHeader title={session.user.name} description="Doctor dashboard" />
      <Tabs defaultValue="appointments" className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-b">
          <TabsTrigger value="appointments" className="flex-none px-4">
            Appointments
          </TabsTrigger>
          <TabsTrigger value="availability" className="flex-none px-4">
            Availability
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

const isActive = (a: DoctorAppointment) => a.status === 'CONFIRMED' || a.status === 'PENDING';

function Appointments({ session }: { session: Session }) {
  const today = useClinicToday();
  const now = useNow();
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const date = pickedDate ?? today;

  const appointments = useQuery(`doctor-appointments:${session.user.id}`, () =>
    api<DoctorAppointment[]>('/doctor-portal/appointments?scope=all', { token: session.accessToken }),
  );

  // New bookings show up without a manual refresh.
  const reloadRef = useRef(appointments.reload);
  useEffect(() => {
    reloadRef.current = appointments.reload;
  });
  useEffect(() => {
    const timer = setInterval(() => reloadRef.current(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const list = appointments.data ?? appointments.previous;
  const all = list ?? [];
  const active = all.filter(isActive);
  const countOn = (d: string) => active.filter((a) => a.date === d).length;
  const upcoming = today ? active.filter((a) => a.date >= today) : [];
  const newlyBooked = upcoming.filter((a) => now - Date.parse(a.bookedAt) < NEW_BOOKING_MS);
  const dayItems = date
    ? all.filter((a) => a.date === date).sort((a, b) => a.startTime.localeCompare(b.startTime))
    : [];
  const week = today ? Array.from({ length: 7 }, (_, i) => addDays(today, i)) : [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Today" value={today && list ? countOn(today) : '–'} />
        <Stat label="Upcoming" value={list ? upcoming.length : '–'} />
        <Stat label="New (24 h)" value={list ? newlyBooked.length : '–'} highlight={newlyBooked.length > 0} />
      </div>

      <Card className="[--card-spacing:--spacing(4)]">
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Previous day"
                disabled={!date}
                onClick={() => date && setPickedDate(addDays(date, -1))}
              >
                <ChevronLeftIcon aria-hidden />
              </Button>
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Next day"
                disabled={!date}
                onClick={() => date && setPickedDate(addDays(date, 1))}
              >
                <ChevronRightIcon aria-hidden />
              </Button>
              <Button variant="outline" size="lg" disabled={!today || date === today} onClick={() => setPickedDate(null)}>
                Today
              </Button>
              <label className="sr-only" htmlFor="schedule-date">
                Choose a date
              </label>
              <Input
                id="schedule-date"
                type="date"
                value={date ?? ''}
                onChange={(event) => event.target.value && setPickedDate(event.target.value)}
                className="h-9 w-40"
              />
            </div>
            <Button variant="outline" size="lg" onClick={appointments.reload} disabled={appointments.loading} className="gap-2">
              <RefreshCwIcon className={cn(appointments.loading && 'animate-spin')} aria-hidden />
              {appointments.loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>

          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Next 7 days">
            {week.map((d) => {
              const count = countOn(d);
              const selected = d === date;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${formatDate(d, { weekday: 'long' })}, ${count} appointment${count === 1 ? '' : 's'}`}
                  onClick={() => setPickedDate(d === today ? null : d)}
                  className={cn(
                    'flex min-w-19 flex-1 flex-col items-center rounded-xl border px-2 py-2 text-sm transition-all focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    selected ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'bg-card hover:border-primary/60',
                  )}
                >
                  <span className="text-xs font-medium">{d === today ? 'Today' : DAY_SHORT[dayOfWeek(d)]}</span>
                  <span className="text-lg font-bold">{Number(d.slice(8))}</span>
                  <span
                    className={cn(
                      'mt-0.5 rounded-full px-1.5 text-[11px] font-semibold whitespace-nowrap',
                      selected ? 'bg-black/20' : count > 0 ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {count > 0 ? `${count} booked` : 'free'}
                  </span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {!list && appointments.loading && <Spinner label="Loading appointments…" />}
      {appointments.error && (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={appointments.reload}>
              Try again
            </Button>
          }
        >
          {appointments.error}
        </Alert>
      )}

      {list && date && (
        <section aria-labelledby="day-heading" className="space-y-3">
          <h2 id="day-heading" className="flex flex-wrap items-center gap-2 text-lg font-semibold text-foreground">
            {formatDate(date, { weekday: 'long' })}
            {relativeDay(date, today) && <Badge variant="secondary">{relativeDay(date, today)}</Badge>}
            <span className="text-sm font-normal text-muted-foreground">
              {dayItems.length} appointment{dayItems.length === 1 ? '' : 's'}
            </span>
          </h2>

          {dayItems.length === 0 ? (
            <EmptyState title="No appointments on this day" icon={CalendarPlusIcon}>
              New bookings from patients appear here automatically.
            </EmptyState>
          ) : (
            <Card className="py-0">
              <ul className="divide-y">
                {dayItems.map((a) => {
                  const isNew = isActive(a) && now - Date.parse(a.bookedAt) < NEW_BOOKING_MS;
                  return (
                    <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 sm:flex-nowrap">
                      <div className="w-24 shrink-0">
                        <p className="font-semibold text-foreground">{formatTime(a.startTime)}</p>
                        <p className="text-xs text-muted-foreground">until {formatTime(a.endTime)}</p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                          {a.patient.name}
                          {isNew && <Badge className="bg-primary/10 text-primary">New</Badge>}
                        </p>
                        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <PhoneIcon className="size-3.5" aria-hidden />
                            {a.patient.phone ?? 'No phone on file'}
                          </span>
                          <span>Booked {timeAgo(a.bookedAt, now)}</span>
                        </p>
                      </div>
                      <StatusBadge status={a.status} />
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarCheckIcon className="size-3.5" aria-hidden />
            Updates automatically every 30 seconds.
          </p>
        </section>
      )}
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
