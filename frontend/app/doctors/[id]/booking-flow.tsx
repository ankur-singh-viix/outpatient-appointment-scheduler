'use client';

import { CheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Avatar, EmptyState, Spinner } from '@/components/common';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { BOOKING_DAYS_SHOWN } from '@/lib/config';
import { addDays, dayOfWeek, DAY_SHORT, formatDate, formatFee, formatTime, initials, summariseWeeklyHours } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import { useHydrated, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import type { DaySchedule, Doctor, PatientAppointment, Slot } from '@/lib/types';

export function BookingFlow() {
  const { id } = useParams<{ id: string }>();
  const doctor = useQuery(`doctor:${id}`, () => api<Doctor>(`/doctors/${id}`));
  const [confirmed, setConfirmed] = useState<PatientAppointment | null>(null);

  if (doctor.loading) return <Spinner label="Loading doctor…" />;
  if (doctor.error || !doctor.data) {
    return (
      <EmptyState title="We couldn't load this doctor">
        <p>{doctor.error}</p>
        <Link href="/" className={buttonVariants({ variant: 'link' })}>
          Back to all doctors
        </Link>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm font-medium text-primary hover:underline">
        ← All doctors
      </Link>
      <DoctorHeader doctor={doctor.data} />
      {confirmed ? (
        <BookingSuccess appointment={confirmed} onBookAnother={() => setConfirmed(null)} />
      ) : (
        <SlotPicker doctor={doctor.data} onBooked={setConfirmed} />
      )}
    </div>
  );
}

function DoctorHeader({ doctor }: { doctor: Doctor }) {
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Avatar text={initials(doctor.name)} />
        <div className="flex-1 space-y-1">
          <h1 className="text-2xl font-bold text-foreground">{doctor.name}</h1>
          <p className="font-medium text-primary">{doctor.specialty.name}</p>
          {doctor.bio && <p className="text-sm text-foreground/80">{doctor.bio}</p>}
          <p className="text-sm text-muted-foreground">
            {doctor.clinic.name} · {doctor.clinic.address}
          </p>
          <p className="text-sm text-muted-foreground">
            {summariseWeeklyHours(doctor.weeklyHours).join(' · ') || 'No regular hours set'}
          </p>
        </div>
        <div className="rounded-lg bg-muted px-4 py-3 text-sm sm:text-right">
          <p className="text-muted-foreground">Consultation fee</p>
          <p className="text-xl font-bold text-foreground">{formatFee(doctor.consultationFee)}</p>
          <p className="text-muted-foreground">{doctor.consultationMinutes} min visit</p>
        </div>
      </CardContent>
    </Card>
  );
}

const SLOT_STYLES: Record<Slot['status'], string> = {
  AVAILABLE: 'border-primary/60 bg-card text-primary hover:bg-accent',
  BOOKED: 'border-border bg-muted text-muted-foreground/60 line-through',
  FULL: 'border-amber-200 bg-amber-50 text-amber-700/70',
  PAST: 'border-border bg-muted/50 text-muted-foreground/40',
};

function sessionLabel(startTime: string) {
  const hour = Number(startTime.slice(0, 2));
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

function SlotPicker({ doctor, onBooked }: { doctor: Doctor; onBooked: (appointment: PatientAppointment) => void }) {
  const today = useClinicToday();
  const session = useSession();
  const hydrated = useHydrated();
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  const date = pickedDate ?? today;
  const schedule = useQuery(date ? `slots:${doctor.id}:${date}` : null, () =>
    api<DaySchedule>(`/doctors/${doctor.id}/slots?date=${date}`),
  );
  const workingDays = new Set(doctor.weeklyHours.map((h) => h.dayOfWeek));
  const dates = today ? Array.from({ length: BOOKING_DAYS_SHOWN }, (_, i) => addDays(today, i)) : [];

  const chooseDate = (next: string) => {
    setPickedDate(next);
    setSelected(null);
    setBookingError(null);
  };

  const confirm = async () => {
    if (!selected || !date || !session) return;
    setSubmitting(true);
    setBookingError(null);
    try {
      const appointment = await api<PatientAppointment>('/appointments', {
        method: 'POST',
        token: session.accessToken,
        body: { doctorId: doctor.id, date, startTime: selected.startTime },
      });
      onBooked(appointment);
    } catch (error) {
      setBookingError(errorMessage(error));
      setSelected(null);
      schedule.reload(); // Someone else may have taken the slot: show fresh availability.
    } finally {
      setSubmitting(false);
    }
  };

  const slots = schedule.data?.slots ?? [];
  const availableCount = slots.filter((slot) => slot.status === 'AVAILABLE').length;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card className="min-w-0 [--card-spacing:--spacing(5)]">
        <CardContent className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-foreground">1. Choose a date</h2>
            <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-2" role="listbox" aria-label="Appointment date">
              {dates.map((d) => {
                const active = d === date;
                const works = workingDays.has(dayOfWeek(d));
                return (
                  <button
                    key={d}
                    role="option"
                    aria-selected={active}
                    onClick={() => chooseDate(d)}
                    className={cn(
                      'flex w-16 shrink-0 flex-col items-center rounded-lg border px-2 py-2 text-sm transition focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : works
                          ? 'bg-card text-foreground hover:border-primary/60'
                          : 'bg-muted text-muted-foreground/60',
                    )}
                  >
                    <span className="text-xs">{d === today ? 'Today' : DAY_SHORT[dayOfWeek(d)]}</span>
                    <span className="text-lg font-bold">{Number(d.slice(8))}</span>
                    <span className="text-xs">{formatDate(d, { weekday: undefined, day: undefined, year: undefined })}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-foreground">2. Pick a time</h2>
              {date && <p className="text-sm text-muted-foreground">{formatDate(date, { weekday: 'long' })}</p>}
            </div>

            {bookingError && (
              <div className="mt-3">
                <Alert>{bookingError}</Alert>
              </div>
            )}

            {(schedule.loading || !date) && <Spinner label="Checking availability…" />}
            {schedule.error && (
              <div className="mt-3">
                <Alert
                  action={
                    <Button size="sm" variant="outline" onClick={schedule.reload}>
                      Try again
                    </Button>
                  }
                >
                  {schedule.error}
                </Alert>
              </div>
            )}

            {schedule.data && slots.length === 0 && (
              <div className="mt-3">
                <EmptyState title="No appointments on this date">
                  {schedule.data.unavailableReason ?? 'The doctor does not consult on this day.'} Please choose another date.
                </EmptyState>
              </div>
            )}

            {schedule.data && slots.length > 0 && (
              <div className="mt-3 space-y-5">
                {availableCount === 0 && <Alert tone="info">All slots on this date are taken. Please choose another date.</Alert>}
                {schedule.data.sessions.map((s) => {
                  const sessionSlots = slots.filter((slot) => slot.startTime >= s.startTime && slot.startTime < s.endTime);
                  return (
                    <div key={s.startTime}>
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <h3 className="font-semibold text-foreground">
                          {sessionLabel(s.startTime)} · {formatTime(s.startTime)}–{formatTime(s.endTime)}
                        </h3>
                        <span className={s.remaining === 0 ? 'font-medium text-amber-700' : 'text-muted-foreground'}>
                          {s.remaining === 0 ? 'Session full' : `${s.remaining} of ${s.capacity} bookings left`}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                        {sessionSlots.map((slot) => {
                          const isSelected = selected?.startTime === slot.startTime;
                          return (
                            <Button
                              key={slot.startTime}
                              variant="outline"
                              size="lg"
                              disabled={slot.status !== 'AVAILABLE'}
                              aria-pressed={isSelected}
                              title={slot.status === 'AVAILABLE' ? undefined : slot.status.toLowerCase()}
                              onClick={() => {
                                setSelected(slot);
                                setBookingError(null);
                              }}
                              className={cn(
                                'h-10 font-semibold disabled:opacity-100',
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                                  : SLOT_STYLES[slot.status],
                              )}
                            >
                              {formatTime(slot.startTime)}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                <SlotLegend />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="h-fit [--card-spacing:--spacing(5)] lg:sticky lg:top-24">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">3. Review &amp; confirm</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {selected && date ? (
            <dl className="space-y-3 text-sm">
              <SummaryRow label="Doctor" value={`${doctor.name} · ${doctor.specialty.name}`} />
              <SummaryRow label="Date" value={formatDate(date, { weekday: 'long' })} />
              <SummaryRow label="Time" value={`${formatTime(selected.startTime)} – ${formatTime(selected.endTime)}`} />
              <SummaryRow label="Clinic" value={`${doctor.clinic.name}, ${doctor.clinic.address}`} />
              <SummaryRow label="Fee (pay at clinic)" value={formatFee(doctor.consultationFee)} />
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Select an available time to see your appointment details here.</p>
          )}

          {hydrated && !session && (
            <Link
              href={`/login?next=${encodeURIComponent(`/doctors/${doctor.id}`)}`}
              className={buttonVariants({ size: 'lg', className: 'w-full' })}
            >
              Sign in to book
            </Link>
          )}
          {session && session.user.role !== 'PATIENT' && (
            <Alert tone="info">Sign in with a patient account to book appointments.</Alert>
          )}
          {session?.user.role === 'PATIENT' && (
            <Button size="lg" className="w-full" disabled={!selected || submitting} onClick={confirm}>
              {submitting ? 'Booking…' : selected ? 'Confirm appointment' : 'Select a time slot'}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function SlotLegend() {
  const items: [string, string][] = [
    ['Available', 'border-primary/60 bg-card'],
    ['Booked', 'border-border bg-muted'],
    ['Session full', 'border-amber-200 bg-amber-50'],
    ['Passed', 'border-border bg-muted/50'],
  ];
  return (
    <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      {items.map(([label, style]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className={cn('size-3 rounded border', style)} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}

function BookingSuccess({ appointment, onBookAnother }: { appointment: PatientAppointment; onBookAnother: () => void }) {
  return (
    <Card className="mx-auto max-w-xl [--card-spacing:--spacing(6)]">
      <CardContent className="space-y-5 text-center" aria-live="polite">
        <div
          className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
          aria-hidden
        >
          <CheckIcon className="size-7" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-foreground">Appointment confirmed</h2>
          <p className="mt-1 text-sm text-muted-foreground">Booking reference {appointment.id.slice(0, 8).toUpperCase()}</p>
        </div>
        <dl className="grid gap-3 rounded-lg bg-muted p-4 text-left text-sm sm:grid-cols-2">
          <SummaryRow label="Doctor" value={`${appointment.doctor.name} · ${appointment.doctor.specialty}`} />
          <SummaryRow label="Date" value={formatDate(appointment.date, { weekday: 'long' })} />
          <SummaryRow label="Time" value={`${formatTime(appointment.startTime)} – ${formatTime(appointment.endTime)}`} />
          <SummaryRow label="Fee (pay at clinic)" value={formatFee(appointment.doctor.consultationFee)} />
          <div className="sm:col-span-2">
            <SummaryRow label="Clinic" value={`${appointment.clinic.name}, ${appointment.clinic.address}`} />
          </div>
        </dl>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/appointments" className={buttonVariants({ size: 'lg' })}>
            View my appointments
          </Link>
          <Button size="lg" variant="outline" onClick={onBookAnother}>
            Book another slot
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
