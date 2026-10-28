'use client';

import { CalendarPlusIcon, ChevronLeftIcon, ChevronRightIcon, PhoneIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState, PageHeader, Spinner, StatusBadge } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { addDays, clinicClock, dayOfWeek, DAY_SHORT, formatDate, formatTime, relativeDay, timeAgo } from '@/lib/format';
import { useAutoRefresh, useClinicToday, useNow, useQuery } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { DoctorAppointment, Session } from '@/lib/types';
import { CancelAppointmentDialog } from './cancel-appointment-dialog';

const NEW_BOOKING_MS = 24 * 60 * 60 * 1000;
const isActive = (a: DoctorAppointment) => a.status === 'CONFIRMED' || a.status === 'PENDING';

export function DoctorAppointmentsPage() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor/appointments">
      {(session) => <AppointmentsView session={session} />}
    </RequireRole>
  );
}

function AppointmentsView({ session }: { session: Session }) {
  const today = useClinicToday();
  const now = useNow();
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<DoctorAppointment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const date = pickedDate ?? today;

  const appointments = useQuery(`doctor-appointments:${session.user.id}`, () =>
    api<DoctorAppointment[]>('/doctor-portal/appointments?scope=all', { token: session.accessToken }),
  );
  useAutoRefresh(appointments.reload); // new bookings show up without a manual refresh

  const list = appointments.data ?? appointments.previous;
  const all = list ?? [];
  const countOn = (d: string) => all.filter((a) => isActive(a) && a.date === d).length;
  const dayItems = date ? all.filter((a) => a.date === date).sort((a, b) => a.startTime.localeCompare(b.startTime)) : [];
  const week = today ? Array.from({ length: 7 }, (_, i) => addDays(today, i)) : [];
  const clock = clinicClock(now);
  // Hide Cancel once the appointment has started (the server refuses it too).
  const canCancel = (a: DoctorAppointment) =>
    isActive(a) && (a.date > clock.date || (a.date === clock.date && a.startTime > clock.time));

  return (
    <div className="animate-in fade-in-0 duration-300">
      <PageHeader
        title="Appointments"
        description="Your schedule by day. If you cannot see a patient, cancel with a reason and they are told."
        action={
          <Button variant="outline" size="lg" onClick={appointments.reload} disabled={appointments.loading} className="gap-2">
            <RefreshCwIcon className={cn(appointments.loading && 'animate-spin')} aria-hidden />
            {appointments.loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      <div className="space-y-6">
        {notice && <Alert tone="success">{notice}</Alert>}

        <Card className="[--card-spacing:--spacing(4)]">
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="outline" size="icon-lg" aria-label="Previous day" disabled={!date} onClick={() => date && setPickedDate(addDays(date, -1))}>
                <ChevronLeftIcon aria-hidden />
              </Button>
              <Button variant="outline" size="icon-lg" aria-label="Next day" disabled={!date} onClick={() => date && setPickedDate(addDays(date, 1))}>
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
                    const cancelled = a.status === 'CANCELLED';
                    return (
                      <li key={a.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:flex-nowrap', cancelled && 'bg-muted/40')}>
                        <div className="w-20 shrink-0 sm:w-24">
                          <p className={cn('font-semibold text-foreground', cancelled && 'text-muted-foreground line-through')}>{formatTime(a.startTime)}</p>
                          <p className="text-xs text-muted-foreground">until {formatTime(a.endTime)}</p>
                        </div>
                        <div className="min-w-0 flex-1 basis-40">
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
                          {cancelled && (
                            <p className="mt-1 text-sm text-muted-foreground">
                              {a.cancelledBy === 'DOCTOR' ? 'Cancelled by you' : a.cancelledBy === 'PATIENT' ? 'Cancelled by the patient' : 'Cancelled'}
                              {a.cancelReason && <> · Reason: {a.cancelReason}</>}
                            </p>
                          )}
                        </div>
                        {/* On a phone the status and Cancel drop onto their own line under the patient's details. */}
                        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                          <StatusBadge status={a.status} />
                          {canCancel(a) && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              aria-label={`Cancel appointment with ${a.patient.name} at ${formatTime(a.startTime)}`}
                              onClick={() => setCancelling(a)}
                            >
                              Cancel
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </section>
        )}
      </div>

      <CancelAppointmentDialog
        appointment={cancelling}
        session={session}
        onClose={() => setCancelling(null)}
        onCancelled={(cancelled) => {
          setCancelling(null);
          setNotice(`Appointment with ${cancelled.patient.name} cancelled. They can see your reason, and the time is free again.`);
          appointments.reload();
        }}
      />
    </div>
  );
}
