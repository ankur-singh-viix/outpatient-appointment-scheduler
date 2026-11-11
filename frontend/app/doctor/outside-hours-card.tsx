'use client';

import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatTimeRange } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { DoctorAppointment, OutsideHoursAppointment, OutsideHoursPage, ScheduleChangeSummary, Session } from '@/lib/types';
import { CancelAppointmentDialog } from './cancel-appointment-dialog';

type Feedback = { tone: 'success' | 'error'; message: string } | null;

const ASKED: Record<string, string> = { SENT: 'email sent', PENDING: 'email on its way', FAILED: 'email could not be sent', CANCELLED: 'email withdrawn' };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line on what a past change of hours did to the appointments it touched. */
function changeOutcome(change: ScheduleChangeSummary): string {
  const stranded =
    change.kind === 'EXPAND'
      ? ''
      : change.affected === 0
        ? 'No booked appointment was affected.'
        : `${plural(change.affected, 'appointment')} affected: ${change.unresolved} still waiting for a new time, ${change.rescheduled} moved by the patient, ${change.cancelled} cancelled.`;
  let released = '';
  if (change.kind !== 'SHRINK') {
    released =
      change.restored > 0
        ? `${plural(change.restored, 'appointment')} waiting for a new time ${change.restored === 1 ? 'was' : 'were'} back inside the hours, so ${change.restored === 1 ? 'its patient' : 'their patients'} did not need to move.`
        : change.kind === 'EXPAND'
          ? 'No waiting appointment was affected.'
          : '';
  }
  return [stranded, released].filter(Boolean).join(' ');
}

const FOLLOW_UP: Record<string, string> = {
  NOT_ASKED: 'Not asked yet',
  WAITING: 'Waiting for the patient',
  NO_RESPONSE: 'No response after both reminders',
  NO_ALTERNATIVES: 'No other time open',
};
const FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'NO_RESPONSE', label: 'No response' },
  { value: 'NO_ALTERNATIVES', label: 'No other time' },
  { value: 'NOT_ASKED', label: 'Not asked' },
  { value: 'WAITING', label: 'Waiting' },
] as const;

function askedText(appointment: OutsideHoursAppointment): string {
  if (appointment.asked) return `Asked ${formatDateTime(appointment.asked.at)} (${ASKED[appointment.asked.status] ?? appointment.asked.status.toLowerCase()})${appointment.followUp.reminders > 0 ? `, ${plural(appointment.followUp.reminders, 'reminder')} sent` : ''}`;
  return appointment.noticePending ? 'Waiting to be asked (the email is being queued)' : 'Not asked yet';
}

/**
 * Booked appointments that are outside the doctor's hours as they stand (hours were reduced, or a day was taken off). They are still
 * booked: the doctor asks each patient to choose a new time, which the patient confirms themselves, and cancels only as a last
 * resort, with the usual reason, notice and refund. A page at a time, so a large change stays quick. Shown only while there are
 * any (or recent changes to look back on).
 */
export function OutsideHoursCard({ session, version, onChanged, onAddSession }: { session: Session; version: number; onChanged: () => void; onAddSession?: (date: string) => void }) {
  const list = useQuery(`outside-hours:${session.user.id}:${version}`, () => api<OutsideHoursPage>('/doctor-portal/appointments/outside-hours', { token: session.accessToken }));
  const history = useQuery(`schedule-changes:${session.user.id}:${version}`, () => api<{ changes: ScheduleChangeSummary[] }>('/doctor-portal/schedule-changes?limit=5', { token: session.accessToken }));
  // Pages loaded after the first one, remembered together with the first page they follow: a fresh first page discards them.
  const [loaded, setLoaded] = useState<{ base: OutsideHoursPage | undefined; items: OutsideHoursAppointment[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cancelling, setCancelling] = useState<DoctorAppointment | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('ALL');

  const more = loaded && loaded.base === list.data ? loaded : null;
  const firstPage = (list.data ?? list.previous)?.appointments ?? [];
  const items = [...firstPage, ...(more?.items ?? []).filter((entry) => !firstPage.some((existing) => existing.id === entry.id))];
  const nextCursor = more ? more.cursor : (list.data ?? list.previous)?.nextCursor ?? null;
  const shown = filter === 'ALL' ? items : items.filter((entry) => entry.followUp.state === filter);
  const changes = (history.data ?? history.previous)?.changes ?? [];
  if (items.length === 0 && !feedback && changes.length === 0) return null;

  const showMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<OutsideHoursPage>(`/doctor-portal/appointments/outside-hours?cursor=${encodeURIComponent(nextCursor)}`, { token: session.accessToken });
      setLoaded({ base: list.data, items: [...(more?.items ?? []), ...page.appointments], cursor: page.nextCursor });
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setLoadingMore(false);
    }
  };

  const ask = async (appointment: OutsideHoursAppointment) => {
    setBusy(appointment.id);
    setFeedback(null);
    try {
      await api(`/doctor-portal/appointments/${appointment.id}/ask-new-time`, {
        method: 'POST',
        token: session.accessToken,
        body: {},
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
          These patients are still booked, but their time is no longer within your availability. Each one is asked to choose a new time and confirms the move themselves. Cancel only as a last
          resort.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every appointment is now inside your hours.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
              {FILTERS.map((option) => (
                <Button key={option.value} size="sm" variant={filter === option.value ? 'default' : 'outline'} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
                  {option.label}
                  {option.value !== 'ALL' && ` (${items.filter((entry) => entry.followUp.state === option.value).length})`}
                </Button>
              ))}
            </div>
            {shown.length === 0 && <p className="text-sm text-muted-foreground">No loaded appointment matches this filter.</p>}
            <ul className="divide-y rounded-xl border bg-card" aria-label="Appointments outside your hours">
              {shown.map((appointment) => (
                <li key={appointment.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                        {appointment.patient.name}
                        <Badge variant="secondary" className="bg-amber-100 text-amber-900">
                          Needs a new time
                        </Badge>
                        {appointment.followUp.state !== 'WAITING' && (
                          <Badge variant="secondary" className={appointment.followUp.state === 'NOT_ASKED' ? 'bg-muted text-foreground' : 'bg-red-100 text-red-900'}>
                            {FOLLOW_UP[appointment.followUp.state]}
                          </Badge>
                        )}
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
                    <p className="text-sm text-muted-foreground">{askedText(appointment)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {appointment.alternatives.length > 0 ? (
                      <p className="text-sm text-muted-foreground">The patient picks their own new time from {appointment.alternatives.length === 1 ? 'the open time' : 'the open times'}, nearest first.</p>
                    ) : (
                      <>
                        <p className="text-sm text-amber-900">No other time is open for this patient right now.</p>
                        {onAddSession && (
                          <Button variant="outline" size="sm" onClick={() => onAddSession(appointment.date)} aria-label={`Add a one-time session for ${appointment.patient.name}`}>
                            Add a one-time session
                          </Button>
                        )}
                      </>
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
            {nextCursor && (
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void showMore()}>
                {loadingMore ? 'Loading…' : 'Show more appointments'}
              </Button>
            )}
          </>
        )}

        {changes.length > 0 && (
          <details className="rounded-xl border bg-card px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-foreground">Recent changes to your hours</summary>
            <ul className="mt-3 space-y-2 text-muted-foreground" aria-label="Recent changes to your hours">
              {changes.map((change) => (
                <li key={change.id}>
                  <span className="font-medium text-foreground">{formatDateTime(change.createdAt)}</span>: {change.oldStart}–{change.oldEnd} became {change.newStart}–{change.newEnd} from {formatDate(change.applyFrom)}.{' '}
                  {changeOutcome(change)}
                </li>
              ))}
            </ul>
          </details>
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
