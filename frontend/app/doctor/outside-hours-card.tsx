'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatTime, formatTimeRange } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { DoctorAppointment, OpenTime, OutsideHoursAppointment, Session } from '@/lib/types';
import { CancelAppointmentDialog } from './cancel-appointment-dialog';

type Feedback = { tone: 'success' | 'error'; message: string } | null;

const ASKED: Record<string, string> = { SENT: 'email sent', PENDING: 'email on its way', FAILED: 'email could not be sent', CANCELLED: 'email withdrawn' };
const optionLabel = (option: OpenTime) => `${formatDate(option.date, { weekday: 'short' })} · ${formatTime(option.startTime)} (${option.remaining} left)`;

/**
 * Booked appointments that are outside the doctor's hours as they stand (hours were reduced, or a day was taken off). They are still
 * booked: the doctor asks each patient to choose a new time, which the patient confirms themselves, and cancels only as a last
 * resort, with the usual reason, notice and refund. Shown only while there are any.
 */
export function OutsideHoursCard({ session, version, onChanged }: { session: Session; version: number; onChanged: () => void }) {
  const list = useQuery(`outside-hours:${session.user.id}:${version}`, () => api<{ appointments: OutsideHoursAppointment[] }>('/doctor-portal/appointments/outside-hours', { token: session.accessToken }));
  const [choice, setChoice] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cancelling, setCancelling] = useState<DoctorAppointment | null>(null);

  const items = (list.data ?? list.previous)?.appointments ?? [];
  if (items.length === 0 && !feedback) return null;

  const ask = async (appointment: OutsideHoursAppointment) => {
    const option = appointment.alternatives[choice[appointment.id] ?? -1];
    setBusy(appointment.id);
    setFeedback(null);
    try {
      await api(`/doctor-portal/appointments/${appointment.id}/ask-new-time`, {
        method: 'POST',
        token: session.accessToken,
        body: option ? { proposal: { date: option.date, startTime: option.startTime } } : {},
      });
      setFeedback({ tone: 'success', message: `${appointment.patient.name} was asked to choose a new time. Their appointment stays booked until they do.` });
      list.reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const startCancel = (appointment: OutsideHoursAppointment) =>
    setCancelling({
      id: appointment.id,
      date: appointment.date,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      status: appointment.status,
      cancelReason: null,
      cancelledAt: null,
      cancelledBy: null,
      bookedAt: '',
      patient: appointment.patient,
    });

  return (
    <Card className="border-amber-200 [--card-spacing:--spacing(6)]">
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlertIcon className="size-5 text-amber-700" aria-hidden />
          Appointments outside your hours
        </CardTitle>
        <CardDescription>
          These patients are still booked, but their time is no longer within your availability. Ask each one to choose a new time; they confirm the move themselves. Cancel only as a last
          resort.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every appointment is now inside your hours.</p>
        ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Appointments outside your hours">
          {items.map((appointment) => (
            <li key={appointment.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    {appointment.patient.name}
                    {appointment.status === 'PENDING' && (
                      <Badge variant="secondary" className="bg-amber-100 text-amber-900">
                        Awaiting payment
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(appointment.date, { weekday: 'long' })} · {formatTimeRange(appointment.startTime, appointment.endTime)}
                    {appointment.patient.phone ? ` · ${appointment.patient.phone}` : ''}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  {appointment.asked ? `Asked ${formatDateTime(appointment.asked.at)} (${ASKED[appointment.asked.status] ?? appointment.asked.status.toLowerCase()})` : 'Not asked yet'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {appointment.alternatives.length > 0 ? (
                  <>
                    <label htmlFor={`outside-${appointment.id}`} className="text-sm text-muted-foreground">
                      Suggest a time (optional)
                    </label>
                    <select
                      id={`outside-${appointment.id}`}
                      value={choice[appointment.id] ?? -1}
                      onChange={(event) => setChoice((current) => ({ ...current, [appointment.id]: Number(event.target.value) }))}
                      className="h-9 max-w-full rounded-lg border border-input bg-card px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value={-1}>No suggestion</option>
                      {appointment.alternatives.map((option, index) => (
                        <option key={`${option.date}-${option.startTime}`} value={index}>
                          {optionLabel(option)}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <p className="text-sm text-amber-900">No other time is open for this patient right now.</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => void ask(appointment)} aria-label={`Ask to choose a new time: ${appointment.patient.name}`}>
                  {busy === appointment.id ? 'Sending…' : 'Ask to choose a new time'}
                </Button>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => startCancel(appointment)} aria-label={`Cancel appointment (last resort): ${appointment.patient.name}`}>
                  Cancel appointment (last resort)
                </Button>
              </div>
            </li>
          ))}
        </ul>
        )}
      </CardContent>

      <CancelAppointmentDialog
        appointment={cancelling}
        session={session}
        onClose={() => setCancelling(null)}
        onCancelled={(cancelled) => {
          setCancelling(null);
          setFeedback({ tone: 'success', message: `Cancelled the appointment on ${formatDate(cancelled.date)}. The patient was told why.` });
          list.reload();
          onChanged();
        }}
      />
    </Card>
  );
}
