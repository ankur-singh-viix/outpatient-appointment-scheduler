'use client';

import { CalendarCheckIcon, LogInIcon, LogOutIcon, UserXIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { clinicClock, clinicToday, formatDate, formatTime, formatTimeRange } from '@/lib/format';
import { useAutoRefresh, useNow, useQuery } from '@/lib/hooks';
import { queueApi } from '@/lib/queue-client';
import { ARRIVAL_GRACE_MINUTES, actionNotice, arrivalPhase } from '@/lib/queue-view';
import type { ReceptionAppointment, ReceptionDoctor, Session, Slot } from '@/lib/types';
import { SlotPicker } from './slot-picker';

const selectClass =
  'h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * Upcoming appointments for the doctors who assigned this receptionist: check-in / late arrival, cancel, reschedule, manual no-show
 * (after the arrival grace), and check-out once the doctor has completed. Queue actions use the existing queue APIs; cancel/reschedule
 * use the patient's own paths.
 */
export function AppointmentsPanel({
  session,
  doctors,
  version,
  onChanged,
  onOpenQueue,
}: {
  session: Session;
  doctors: ReceptionDoctor[];
  version: number;
  onChanged: (message: string, nextTab?: 'queue') => void;
  onOpenQueue?: () => void;
}) {
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState('');
  const [slotTime, setSlotTime] = useState('');
  const today = clinicToday();
  const query = new URLSearchParams({ ...(date && { date }), ...(doctorId && { doctorId }) }).toString();
  const list = useQuery(`reception-appointments:${session.user.id}:${query}:${version}`, () =>
    api<ReceptionAppointment[]>(`/receptionist/appointments${query ? `?${query}` : ''}`, { token: session.accessToken }),
  );
  useAutoRefresh(list.reload, 30_000);

  const [cancelling, setCancelling] = useState<ReceptionAppointment | null>(null);
  const [reason, setReason] = useState('');
  const [moving, setMoving] = useState<ReceptionAppointment | null>(null);
  const [newDate, setNewDate] = useState('');
  const [newSlot, setNewSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(15_000);
  const clock = clinicClock(now);
  const [checkingIn, setCheckingIn] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [markingNoShow, setMarkingNoShow] = useState<string | null>(null);
  const [checkedInIds, setCheckedInIds] = useState<Set<string>>(() => new Set());
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const [checkOutError, setCheckOutError] = useState<string | null>(null);
  const [noShowError, setNoShowError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const items = (list.data ?? list.previous)?.filter((item) => !slotTime || item.startTime === slotTime);
  const slotOptions = [...new Set((list.data ?? list.previous ?? []).map((item) => item.startTime))].sort();
  const byDate = new Map<string, ReceptionAppointment[]>();
  for (const item of items ?? []) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);

  const closeDialogs = () => {
    setCancelling(null);
    setMoving(null);
    setReason('');
    setNewSlot(null);
    setDialogError(null);
  };

  const run = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setDialogError(null);
    try {
      await work();
      closeDialogs();
      onChanged(message);
      list.reload();
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () =>
    cancelling &&
    run(
      () => api(`/receptionist/appointments/${cancelling.id}/cancel`, { method: 'POST', token: session.accessToken, body: reason.trim() ? { reason: reason.trim() } : {} }),
      `Cancelled ${cancelling.patient.name}'s appointment on ${formatDate(cancelling.date)}. The place is free again.`,
    );

  const move = () =>
    moving &&
    newSlot &&
    run(
      () => api(`/receptionist/appointments/${moving.id}/reschedule`, { method: 'POST', token: session.accessToken, body: { date: newDate, startTime: newSlot.startTime } }),
      `Moved ${moving.patient.name} to ${formatDate(newDate, { weekday: 'long' })} at ${formatTime(newSlot.startTime)}.`,
    );

  const movingDoctor = moving ? doctors.find((doctor) => doctor.id === moving.doctor.id) : undefined;

  return (
    <Card className="[--card-spacing:--spacing(6)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Appointments
        </CardTitle>
        <CardDescription>
          Upcoming appointments for your assigned doctors. Today&apos;s confirmed visits can be checked in or marked late arrival here (even after the {ARRIVAL_GRACE_MINUTES}
          -minute grace) or on the Queue &amp; check-in tab. No show is a separate action after that grace — never automatic. After the doctor
          completes a consultation, check the patient out here.
          {onOpenQueue && (
            <>
              {' '}
              <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={onOpenQueue}>
                Open live queue
              </button>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="appt-doctor">Doctor</Label>
            <select id="appt-doctor" value={doctorId} onChange={(event) => setDoctorId(event.target.value)} className={selectClass}>
              <option value="">All doctors</option>
              {doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="appt-date">Date</Label>
            <Input id="appt-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} className="h-10 w-44 bg-card" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="appt-slot">Appointment slot</Label>
            <select id="appt-slot" value={slotTime} onChange={(event) => setSlotTime(event.target.value)} className={selectClass}>
              <option value="">All slots</option>
              {slotOptions.map((time) => (
                <option key={time} value={time}>
                  {formatTime(time)}
                </option>
              ))}
            </select>
          </div>
          {(date || slotTime) && (
            <Button
              type="button"
              variant="outline"
              className="h-10"
              onClick={() => {
                setDate('');
                setSlotTime('');
              }}
            >
              Clear filters
            </Button>
          )}
        </div>

        {list.error && (
          <Alert
            action={
              <Button size="sm" variant="outline" onClick={list.reload}>
                Try again
              </Button>
            }
          >
            Could not load appointments. {list.error}
          </Alert>
        )}
        {checkInError && <Alert tone="error">{checkInError}</Alert>}
        {checkOutError && <Alert tone="error">{checkOutError}</Alert>}
        {noShowError && <Alert tone="error">{noShowError}</Alert>}
        {list.loading && !items && <Spinner label="Loading appointments…" />}
        {items && items.length === 0 && (
          <EmptyState title={date ? 'No appointments on this date' : 'No upcoming appointments'} icon={CalendarCheckIcon}>
            <p>Bookings made here or online show up in this list.</p>
          </EmptyState>
        )}

        {[...byDate.entries()].map(([day, entries]) => (
          <section key={day} aria-labelledby={`appts-${day}`} className="space-y-2">
            <h3 id={`appts-${day}`} className="border-b pb-2 text-sm font-semibold text-foreground">
              {formatDate(day, { weekday: 'long' })}
            </h3>
            <ul className="divide-y rounded-xl border bg-card">
              {entries.map((appointment) => {
                const readyToCheckOut = appointment.queueStatus === 'COMPLETED' && appointment.queueEntryId != null;
                const canCancel = appointment.status === 'PENDING' || appointment.status === 'CONFIRMED';
                const notYetInQueue =
                  appointment.status === 'CONFIRMED' &&
                  appointment.date === today &&
                  !checkedInIds.has(appointment.id) &&
                  !readyToCheckOut &&
                  (appointment.queueStatus === null || appointment.queueStatus === 'BOOKED');
                const phase = arrivalPhase({
                  appointmentDate: appointment.date,
                  startTime: appointment.startTime,
                  nowDate: clock.date,
                  nowTime: clock.time,
                });
                const late = phase === 'late' || phase === 'no_show_eligible';
                const deskBusy = checkingIn !== null || checkingOut !== null || markingNoShow !== null || busy;
                return (
                  <li key={appointment.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                        {formatTimeRange(appointment.startTime, appointment.endTime)} · {appointment.patient.name}
                        {appointment.queueToken != null && (
                          <Badge variant="secondary" className="font-semibold tabular-nums">
                            Token {appointment.queueToken}
                          </Badge>
                        )}
                        {appointment.slotCapacity > 1 && (
                          <Badge variant="secondary" className="bg-sky-50 font-semibold text-sky-800">
                            Place {appointment.slotNumber} of {appointment.slotCapacity}
                          </Badge>
                        )}
                        {appointment.status === 'PENDING' && (
                          <Badge variant="secondary" className="bg-amber-50 font-semibold text-amber-800">
                            Awaiting payment
                          </Badge>
                        )}
                        {notYetInQueue && late && (
                          <Badge variant="secondary" className="bg-amber-50 font-semibold text-amber-900">
                            {phase === 'no_show_eligible' ? 'Past grace' : 'Late'}
                          </Badge>
                        )}
                        {readyToCheckOut && (
                          <Badge variant="secondary" className="bg-emerald-50 font-semibold text-emerald-900">
                            Ready to check out
                          </Badge>
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {appointment.doctor.name}
                        {appointment.patient.phone ? ` · ${appointment.patient.phone}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {notYetInQueue && (
                        <Button
                          size="sm"
                          disabled={deskBusy}
                          aria-label={`${late ? 'Late arrival' : 'Check in'} ${appointment.patient.name}`}
                          onClick={() => {
                            void (async () => {
                              if (checkingIn) return;
                              setCheckingIn(appointment.id);
                              setCheckInError(null);
                              try {
                                const result = await queueApi.checkIn(session, appointment.id);
                                setCheckedInIds((current) => new Set(current).add(appointment.id));
                                onChanged(actionNotice(late ? 'lateArrival' : 'checkIn', result), 'queue');
                                list.reload();
                              } catch (error) {
                                setCheckInError(errorMessage(error));
                              } finally {
                                setCheckingIn(null);
                              }
                            })();
                          }}
                        >
                          <LogInIcon aria-hidden /> {checkingIn === appointment.id ? 'Checking in…' : late ? 'Late arrival' : 'Check in'}
                        </Button>
                      )}
                      {notYetInQueue && phase === 'no_show_eligible' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={deskBusy}
                          aria-label={`Mark no show for ${appointment.patient.name}`}
                          onClick={() => {
                            void (async () => {
                              if (markingNoShow) return;
                              setMarkingNoShow(appointment.id);
                              setNoShowError(null);
                              try {
                                const result = await queueApi.markNoShow(session, appointment.id);
                                onChanged(actionNotice('noShow', result), 'queue');
                                list.reload();
                              } catch (error) {
                                setNoShowError(errorMessage(error));
                              } finally {
                                setMarkingNoShow(null);
                              }
                            })();
                          }}
                        >
                          <UserXIcon aria-hidden /> {markingNoShow === appointment.id ? 'Working…' : 'No show'}
                        </Button>
                      )}
                      {appointment.status === 'CONFIRMED' && appointment.date === today && checkedInIds.has(appointment.id) && !readyToCheckOut && (
                        <Badge variant="secondary" className="font-semibold">
                          Checked in
                        </Badge>
                      )}
                      {readyToCheckOut && (
                        <Button
                          size="sm"
                          disabled={deskBusy}
                          aria-label={`Check out ${appointment.patient.name}`}
                          onClick={() => {
                            void (async () => {
                              if (checkingOut || !appointment.queueEntryId) return;
                              setCheckingOut(appointment.id);
                              setCheckOutError(null);
                              try {
                                const result = await queueApi.checkOut(session, appointment.queueEntryId);
                                onChanged(actionNotice('checkOut', result), 'queue');
                                list.reload();
                              } catch (error) {
                                setCheckOutError(errorMessage(error));
                              } finally {
                                setCheckingOut(null);
                              }
                            })();
                          }}
                        >
                          <LogOutIcon aria-hidden /> {checkingOut === appointment.id ? 'Checking out…' : 'Check out'}
                        </Button>
                      )}
                      {appointment.status === 'CONFIRMED' && (
                        <Button variant="outline" size="sm" onClick={() => { setMoving(appointment); setNewDate(appointment.date); }} aria-label={`Reschedule ${appointment.patient.name}'s appointment`}>
                          Reschedule
                        </Button>
                      )}
                      {canCancel && (
                        <Button variant="outline" size="sm" onClick={() => setCancelling(appointment)} aria-label={`Cancel ${appointment.patient.name}'s appointment`}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </CardContent>

      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel this appointment?"
        description={cancelling && `${cancelling.patient.name} · ${formatDate(cancelling.date, { weekday: 'long' })}, ${formatTimeRange(cancelling.startTime, cancelling.endTime)} with ${cancelling.doctor.name}`}
        confirmLabel="Cancel appointment"
        cancelLabel="Keep appointment"
        busy={busy}
        error={dialogError}
        onConfirm={() => void cancel()}
        onClose={closeDialogs}
      >
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">Reason (optional)</Label>
          <Input id="cancel-reason" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="For example: patient phoned to cancel" className="h-10" />
          <p className="text-xs text-muted-foreground">The patient is told, and the place becomes available to others. Any online payment is refunded under the usual cancellation policy.</p>
        </div>
      </ConfirmDialog>

      <Dialog open={moving !== null} onOpenChange={(open) => !open && !busy && closeDialogs()}>
        <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto sm:max-w-3xl">
          {moving && movingDoctor && (
            <div className="space-y-4">
              <div>
                <DialogTitle>Reschedule {moving.patient.name}</DialogTitle>
                <DialogDescription>
                  Now: {formatDate(moving.date, { weekday: 'long' })}, {formatTimeRange(moving.startTime, moving.endTime)} with {moving.doctor.name}. Choose the new slot.
                </DialogDescription>
              </div>
              <SlotPicker doctor={movingDoctor} date={newDate} onDateChange={setNewDate} selected={newSlot} onSelect={setNewSlot} />
              {dialogError && <Alert>{dialogError}</Alert>}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" size="lg" className="h-9" onClick={closeDialogs} disabled={busy}>
                  Keep current time
                </Button>
                <Button type="button" size="lg" className="h-9" disabled={busy || !newSlot} onClick={() => void move()}>
                  {busy ? 'Moving…' : newSlot ? `Move to ${formatTime(newSlot.startTime)}` : 'Select a new slot'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
