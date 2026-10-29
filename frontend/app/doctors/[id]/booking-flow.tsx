'use client';

import { ArrowLeftIcon, CalendarIcon, CheckIcon, ClockIcon, IndianRupeeIcon, MapPinIcon, StethoscopeIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Avatar, EmptyState, Spinner } from '@/components/common';
import { PaymentInfo } from '@/components/payment-info';
import { PaymentStep } from '@/components/payment-step';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { BOOKING_DAYS_SHOWN } from '@/lib/config';
import { addDays, dayOfWeek, DAY_SHORT, formatDate, formatFee, formatTime, initials, summariseWeeklyHours } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import { useHydrated, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import type { DaySchedule, Doctor, HeldAppointment, PatientAppointment, PaymentsConfig, Slot } from '@/lib/types';

export function BookingFlow() {
  const { id } = useParams<{ id: string }>();
  const doctor = useQuery(`doctor:${id}`, () => api<Doctor>(`/doctors/${id}`));
  const [confirmed, setConfirmed] = useState<PatientAppointment | null>(null);
  // A booking that holds its slot but still has to be paid for.
  const [held, setHeld] = useState<HeldAppointment | null>(null);
  const config = useQuery('payments-config', () => api<PaymentsConfig>('/payments/config'));

  // Reschedule mode (?reschedule=<appointment id>): find the appointment being moved among the patient's own.
  const searchParams = useSearchParams();
  const rescheduleId = searchParams.get('reschedule');
  const requestedDate = searchParams.get('date'); // set by "Next available" on a doctor card
  const session = useSession();
  const own = useQuery(rescheduleId && session?.user.role === 'PATIENT' ? `reschedule:${rescheduleId}` : null, () =>
    api<PatientAppointment[]>('/appointments/mine', { token: session?.accessToken }),
  );
  const rescheduling =
    rescheduleId && own.data
      ? (own.data.find(
          (a) => a.id === rescheduleId && a.doctor.id === id && (a.status === 'CONFIRMED' || a.status === 'PENDING'),
        ) ?? null)
      : null;
  const rescheduleUnavailable = Boolean(rescheduleId && own.data && !rescheduling);

  const handleBooked = (appointment: PatientAppointment | HeldAppointment) => {
    if ('checkout' in appointment && appointment.checkout) setHeld(appointment);
    else setConfirmed(appointment);
  };

  // After paying, read the appointment back so the confirmation shows the real status and receipt.
  const afterPaid = async () => {
    if (!held || !session) return;
    const fresh = await api<PatientAppointment[]>('/appointments/mine', { token: session.accessToken }).then(
      (list) => list.find((a) => a.id === held.id),
      () => undefined,
    );
    setConfirmed(fresh ?? { ...held, status: 'CONFIRMED', holdExpiresAt: null });
    setHeld(null);
  };

  if (doctor.loading || own.loading) return <Spinner label="Loading doctor…" />;
  if (doctor.error || !doctor.data) {
    return (
      <EmptyState title="We couldn't load this doctor" icon={StethoscopeIcon}>
        <p>{doctor.error}</p>
        <Link href="/" className={buttonVariants({ variant: 'outline' })}>
          Back to all doctors
        </Link>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-300">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
        <ArrowLeftIcon className="size-4" aria-hidden />
        All doctors
      </Link>
      <DoctorHeader doctor={doctor.data} />
      {rescheduleUnavailable && !confirmed && (
        <Alert tone="info">
          That appointment can no longer be rescheduled: it may have been cancelled or already passed. You can still book a new
          time below.
        </Alert>
      )}
      {held && session ? (
        <div className="mx-auto max-w-xl space-y-4">
          <Alert tone="info">
            Your slot with {held.doctor.name} on {formatDate(held.date, { weekday: 'long' })} at {formatTime(held.startTime)} is reserved.
            Complete the payment to confirm it.
          </Alert>
          <PaymentStep
            appointment={held}
            checkout={held.checkout}
            session={session}
            autoOpen
            onPaid={afterPaid}
            onCancelled={() => setHeld(null)}
            onExpired={() => setHeld(null)}
          />
        </div>
      ) : confirmed ? (
        <BookingSuccess
          appointment={confirmed}
          rescheduled={Boolean(confirmed.rescheduledFromId)}
          onBookAnother={() => setConfirmed(null)}
        />
      ) : (
        <SlotPicker
          doctor={doctor.data}
          rescheduling={rescheduling}
          requestedDate={requestedDate}
          paymentsEnabled={Boolean(config.data?.enabled)}
          onBooked={handleBooked}
        />
      )}
    </div>
  );
}

function InfoTile({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted px-4 py-3 text-sm">
      <p className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-0.5 text-lg font-bold text-foreground">{children}</p>
    </div>
  );
}

function DoctorHeader({ doctor }: { doctor: Doctor }) {
  const timings = summariseWeeklyHours(doctor.weeklyHours);
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardContent className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="flex flex-1 gap-4">
          <Avatar text={initials(doctor.name)} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{doctor.name}</h1>
              <Badge variant="secondary" className="bg-accent text-accent-foreground">
                {doctor.specialty.name}
              </Badge>
            </div>
            {doctor.bio && <p className="text-sm text-foreground/80">{doctor.bio}</p>}
            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <MapPinIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {doctor.clinic.name} · {doctor.clinic.address}
            </p>
            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <CalendarIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {timings.join(' · ') || 'No regular hours set'}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:w-104">
          <InfoTile icon={<IndianRupeeIcon className="size-3.5" aria-hidden />} label="Consultation fee">
            {formatFee(doctor.consultationFee)}
          </InfoTile>
          <InfoTile icon={<ClockIcon className="size-3.5" aria-hidden />} label="Visit length">
            {doctor.consultationMinutes} min
          </InfoTile>
        </div>
      </CardContent>
    </Card>
  );
}

const SLOT_LABEL: Record<Slot['status'], string> = {
  AVAILABLE: 'Available',
  BOOKED: 'Booked',
  FULL: 'Full',
  PAST: 'Passed',
};

// Color is never the only cue: booked, full and passed slots also carry a text label.
const SLOT_STYLES: Record<Slot['status'], string> = {
  AVAILABLE: 'border-primary/50 bg-card text-primary hover:bg-accent',
  BOOKED: 'border-border bg-muted text-muted-foreground',
  FULL: 'border-amber-200 bg-amber-50 text-amber-800',
  PAST: 'border-border bg-muted/50 text-muted-foreground/60',
};

function sessionLabel(startTime: string) {
  const hour = Number(startTime.slice(0, 2));
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

function SlotPicker({
  doctor,
  rescheduling,
  requestedDate,
  paymentsEnabled,
  onBooked,
}: {
  doctor: Doctor;
  /** The appointment being moved, when the page was opened from "Reschedule"; null for a new booking. */
  rescheduling: PatientAppointment | null;
  /** A date from the link (?date=), used as the starting date when it is one of the dates offered. */
  requestedDate: string | null;
  paymentsEnabled: boolean;
  onBooked: (appointment: PatientAppointment | HeldAppointment) => void;
}) {
  const today = useClinicToday();
  const session = useSession();
  const hydrated = useHydrated();
  const summaryRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  const deepLinked = useRef(false);

  const offeredDates = today ? Array.from({ length: BOOKING_DAYS_SHOWN }, (_, i) => addDays(today, i)) : [];
  const linkedDate = requestedDate && offeredDates.includes(requestedDate) ? requestedDate : null;
  const date = pickedDate ?? linkedDate ?? today;
  const schedule = useQuery(date ? `slots:${doctor.id}:${date}` : null, () =>
    api<DaySchedule>(`/doctors/${doctor.id}/slots?date=${date}`),
  );
  // "Book appointment" on a doctor card links to #book. Scroll once the slots have loaded: while the page still shows
  // a spinner it is too short to scroll anywhere.
  useEffect(() => {
    if (deepLinked.current || !schedule.data || window.location.hash !== '#book') return;
    deepLinked.current = true;
    bookRef.current?.scrollIntoView({ block: 'start' });
  }, [schedule.data]);

  // A date chosen by link may sit off-screen in the scrolling strip: bring it into view.
  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [date]);

  const workingDays = new Set(doctor.weeklyHours.map((h) => h.dayOfWeek));
  const dates = offeredDates;

  const chooseDate = (next: string) => {
    setPickedDate(next);
    setSelected(null);
    setBookingError(null);
  };

  const chooseSlot = (slot: Slot) => {
    setSelected(slot);
    setBookingError(null);
    // On phones the summary sits below the slots: bring it into view so the next step is obvious.
    if (window.matchMedia('(max-width: 1023px)').matches) {
      summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const confirm = async () => {
    if (!selected || !date || !session) return;
    setSubmitting(true);
    setBookingError(null);
    try {
      const appointment = rescheduling
        ? await api<PatientAppointment>(`/appointments/${rescheduling.id}/reschedule`, {
            method: 'POST',
            token: session.accessToken,
            body: { date, startTime: selected.startTime },
          })
        : await api<PatientAppointment | HeldAppointment>('/appointments', {
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
    <div id="book" ref={bookRef} className="grid scroll-mt-20 gap-6 lg:grid-cols-[1fr_360px]">
      {rescheduling && (
        <div className="lg:col-span-2">
          <Alert tone="info">
            Rescheduling your appointment on {formatDate(rescheduling.date, { weekday: 'long' })} at{' '}
            {formatTime(rescheduling.startTime)}. Pick a new time below. Your current appointment is kept until you confirm.
          </Alert>
        </div>
      )}
      <Card className="min-w-0 [--card-spacing:--spacing(5)]">
        <CardContent className="space-y-8">
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-foreground">1. Choose a date</h2>
              {date && (
                <p className="text-sm text-muted-foreground">{formatDate(date, { weekday: undefined, day: undefined })}</p>
              )}
            </div>
            <div ref={stripRef} className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-2" role="listbox" aria-label="Appointment date">
              {dates.map((d) => {
                const active = d === date;
                const works = workingDays.has(dayOfWeek(d));
                return (
                  <button
                    key={d}
                    type="button"
                    role="option"
                    aria-selected={active}
                    aria-label={`${formatDate(d, { weekday: 'long' })}${works ? '' : ', usually closed'}`}
                    onClick={() => chooseDate(d)}
                    className={cn(
                      'flex w-18 shrink-0 flex-col items-center rounded-xl border px-2 py-2.5 text-sm transition-all focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      active
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                        : works
                          ? 'bg-card text-foreground hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-sm'
                          : 'bg-muted text-muted-foreground hover:border-border',
                    )}
                  >
                    <span className="text-xs font-medium">{d === today ? 'Today' : DAY_SHORT[dayOfWeek(d)]}</span>
                    <span className="text-xl font-bold">{Number(d.slice(8))}</span>
                    <span className="text-[11px]">
                      {works ? formatDate(d, { weekday: undefined, day: undefined, year: undefined }) : 'Closed'}
                    </span>
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
                <EmptyState title="No appointments on this date" icon={CalendarIcon}>
                  {schedule.data.unavailableReason ?? 'The doctor does not consult on this day.'} Please choose another date.
                </EmptyState>
              </div>
            )}

            {schedule.data && slots.length > 0 && (
              <div className="mt-4 space-y-6 animate-in fade-in-0 duration-300">
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
                          const bookable = slot.status === 'AVAILABLE';
                          return (
                            <Button
                              key={slot.startTime}
                              variant="outline"
                              disabled={!bookable}
                              aria-pressed={isSelected}
                              aria-label={`${formatTime(slot.startTime)}, ${isSelected ? 'selected' : SLOT_LABEL[slot.status].toLowerCase()}`}
                              onClick={() => chooseSlot(slot)}
                              className={cn(
                                'h-12 flex-col gap-0 font-semibold transition-all disabled:opacity-100',
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground'
                                  : SLOT_STYLES[slot.status],
                              )}
                            >
                              <span className={cn('flex items-center gap-1', slot.status === 'BOOKED' && 'line-through')}>
                                {isSelected && <CheckIcon className="size-3.5" aria-hidden />}
                                {formatTime(slot.startTime)}
                              </span>
                              {!bookable && <span className="text-[10px] font-medium tracking-wide uppercase">{SLOT_LABEL[slot.status]}</span>}
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

      <div ref={summaryRef} className="h-fit scroll-mt-24 lg:sticky lg:top-24">
        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle as="h2" className="text-lg font-semibold">
              3. Review &amp; confirm
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected && date ? (
              <dl className="space-y-3 text-sm animate-in fade-in-0 duration-200">
                <SummaryRow label="Doctor" value={`${doctor.name} · ${doctor.specialty.name}`} />
                <SummaryRow label="Date" value={formatDate(date, { weekday: 'long' })} />
                <SummaryRow
                  label="Time"
                  value={`${formatTime(selected.startTime)} – ${formatTime(selected.endTime)} (${doctor.consultationMinutes} min)`}
                />
                <SummaryRow label="Clinic" value={`${doctor.clinic.name}, ${doctor.clinic.address}`} />
                <SummaryRow label="Fee (pay at clinic)" value={formatFee(doctor.consultationFee)} />
                {rescheduling && (
                  <SummaryRow
                    label="Moving from"
                    value={`${formatDate(rescheduling.date, { weekday: 'long' })}, ${formatTime(rescheduling.startTime)}`}
                  />
                )}
              </dl>
            ) : (
              <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                Select an available time to see your appointment details here.
              </p>
            )}

            {hydrated && !session && (
              <Link
                href={`/login?next=${encodeURIComponent(`/doctors/${doctor.id}`)}`}
                className={buttonVariants({ size: 'lg', className: 'h-10 w-full' })}
              >
                Sign in to book
              </Link>
            )}
            {session && session.user.role !== 'PATIENT' && (
              <Alert tone="info">Sign in with a patient account to book appointments.</Alert>
            )}
            {session?.user.role === 'PATIENT' && (
              <Button size="lg" className="h-10 w-full" disabled={!selected || submitting} onClick={confirm}>
                {submitting
                  ? rescheduling
                    ? 'Rescheduling…'
                    : 'Booking…'
                  : selected
                    ? rescheduling
                      ? 'Confirm new time'
                      : paymentsEnabled && doctor.consultationFee > 0
                        ? `Continue to pay ${formatFee(doctor.consultationFee)}`
                        : 'Confirm appointment'
                    : 'Select a time slot'}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function SlotLegend() {
  const items: [string, string][] = [
    ['Available', 'border-primary/50 bg-card'],
    ['Selected', 'border-primary bg-primary'],
    ['Booked', 'border-border bg-muted'],
    ['Session full', 'border-amber-200 bg-amber-50'],
    ['Passed', 'border-border bg-muted/50'],
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-4 text-xs text-muted-foreground" aria-label="Slot colour guide">
      {items.map(([label, style]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className={cn('size-3 rounded border', style)} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}

function BookingSuccess({
  appointment,
  rescheduled,
  onBookAnother,
}: {
  appointment: PatientAppointment;
  rescheduled: boolean;
  onBookAnother: () => void;
}) {
  return (
    <Card className="mx-auto max-w-xl [--card-spacing:--spacing(6)] animate-in fade-in-0 zoom-in-95 duration-300">
      <CardContent className="space-y-5 text-center" aria-live="polite">
        <div
          className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 animate-in zoom-in-50 duration-500"
          aria-hidden
        >
          <CheckIcon className="size-7" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-foreground">{rescheduled ? 'Appointment rescheduled' : 'Appointment confirmed'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Booking reference {appointment.id.slice(0, 8).toUpperCase()}
            {rescheduled && ' · your previous time has been released'}
          </p>
        </div>
        <dl className="grid gap-3 rounded-lg bg-muted p-4 text-left text-sm sm:grid-cols-2">
          <SummaryRow label="Doctor" value={`${appointment.doctor.name} · ${appointment.doctor.specialty}`} />
          <SummaryRow label="Date" value={formatDate(appointment.date, { weekday: 'long' })} />
          <SummaryRow label="Time" value={`${formatTime(appointment.startTime)} – ${formatTime(appointment.endTime)}`} />
          {appointment.payment ? (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Payment</dt>
              <dd className="mt-1 font-medium text-foreground">
                <PaymentInfo payment={appointment.payment} />
              </dd>
            </div>
          ) : (
            <SummaryRow label="Fee (pay at clinic)" value={formatFee(appointment.doctor.consultationFee)} />
          )}
          <SummaryRow className="sm:col-span-2" label="Clinic" value={`${appointment.clinic.name}, ${appointment.clinic.address}`} />
        </dl>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/appointments" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
            View my appointments
          </Link>
          {!rescheduled && (
            <Button size="lg" variant="outline" className="h-10" onClick={onBookAnother}>
              Book another slot
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
