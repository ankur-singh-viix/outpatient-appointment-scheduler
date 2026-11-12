'use client';

import { CalendarOffIcon, CalendarRangeIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate, formatTimeRange } from '@/lib/format';
import { useClinicToday, useQuery } from '@/lib/hooks';
import { SLOT_CHIP_STYLES, slotStatusText } from '@/lib/slot-display';
import type { Session, Slot, UpcomingDay, UpcomingSchedule, UpcomingSession } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ModeBadge } from './availability-list';

type Feedback = { tone: 'success' | 'error'; message: string } | null;
type Target = { day: UpcomingDay; session: UpcomingSession; slot: Slot | null } | null;

const RANGES = [7, 14, 30];

const slotLabel = (slot: Slot, session: UpcomingSession) => slotStatusText(slot, session.mode, session.capacityPerSlot);

const bookedIn = (session: UpcomingSession) => session.booked > 0 || session.slots.some((slot) => (slot.booked ?? 0) > 0);

/**
 * The next days as patients see them, from the server's own slot rules: every session with every slot and its status. A slot, or a
 * whole session, can be cancelled from here; the server refuses (and this explains why) when patients have booked in that time.
 */
export function UpcomingScheduleCard({ session, version, onChanged }: { session: Session; version: number; onChanged: () => void }) {
  const today = useClinicToday();
  const [days, setDays] = useState(14);
  const schedule = useQuery(`upcoming-schedule:${session.user.id}:${days}:${version}`, () =>
    api<UpcomingSchedule>(`/doctor-portal/schedule?days=${days}`, { token: session.accessToken }),
  );
  const [target, setTarget] = useState<Target>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  // Set once the server has said which booked appointments a deletion would affect and the doctor presses the button again to agree.
  const [agreed, setAgreed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const data = schedule.data ?? schedule.previous;
  const close = () => {
    setTarget(null);
    setDialogError(null);
    setAgreed(false);
  };

  /** Why the chosen slot or session cannot be cancelled right now, or null when it can. */
  const unavailable = (chosen: NonNullable<Target>): string | null => {
    const { day, session: part, slot } = chosen;
    const booked = slot ? (slot.booked ?? 0) > 0 : bookedIn(part);
    // Deleting a whole one-time session is allowed with bookings: they stay booked and the patients are asked to choose a new time.
    const deletesOneTimeSession = !slot && part.source === 'ONE_TIME' && Boolean(part.availabilityId);
    if (booked && !deletesOneTimeSession) return `${slot ? 'Patients have booked this slot' : 'Patients have booked in this session'}. Cancel their appointments from Appointments first, so each patient is told and refunded.`;
    if (part.source === 'OVERRIDE') return 'This date has custom hours. Change them under Date exceptions.';
    if (day.exception && !(part.source === 'ONE_TIME' && !slot)) return 'This date already has an exception (a day off or a blocked time). Change it under Date exceptions.';
    return null;
  };

  const confirm = async () => {
    if (!target) return;
    const { day, session: part, slot } = target;
    setBusy(true);
    setDialogError(null);
    try {
      if (!slot && part.source === 'ONE_TIME' && part.availabilityId) {
        await api(`/doctor-portal/availability/one-time/${part.availabilityId}${agreed ? '?acknowledge=true' : ''}`, { method: 'DELETE', token: session.accessToken });
        setFeedback({ tone: 'success', message: `Deleted the session on ${formatDate(day.date)}.` });
      } else {
        const [startTime, endTime] = slot ? [slot.startTime, slot.endTime] : [part.startTime, part.endTime];
        await api('/doctor-portal/schedule/cancel', { method: 'POST', token: session.accessToken, body: { date: day.date, startTime, endTime } });
        setFeedback({ tone: 'success', message: `Cancelled ${formatTimeRange(startTime, endTime)} on ${formatDate(day.date)}. Patients can no longer book it.` });
      }
      close();
      schedule.reload();
      onChanged();
    } catch (error) {
      // Booked appointments would fall outside the hours: nothing was changed, and the doctor may agree and press the button again.
      if (error instanceof ApiError && error.code === 'ACKNOWLEDGE_REQUIRED') setAgreed(true);
      setDialogError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const reason = target ? unavailable(target) : null;
  const slotTarget = target?.slot ?? null;

  return (
    <Card className="[--card-spacing:--spacing(6)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Upcoming schedule
        </CardTitle>
        <CardDescription>Your sessions and slots as patients see them. Select a slot to cancel it, or cancel a whole session.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Show
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="h-9 rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {RANGES.map((range) => (
                <option key={range} value={range}>
                  the next {range} days
                </option>
              ))}
            </select>
          </label>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Slot colour guide">
            <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-primary/40 bg-card" aria-hidden /> Available</li>
            <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm border bg-muted" aria-hidden /> Booked or full</li>
            <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm border bg-muted/50" aria-hidden /> Passed</li>
          </ul>
        </div>

        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}
        {schedule.error && (
          <Alert
            action={
              <Button size="sm" variant="outline" onClick={schedule.reload}>
                Try again
              </Button>
            }
          >
            Could not load your schedule. {schedule.error}
          </Alert>
        )}
        {schedule.loading && !data && <Spinner label="Loading your schedule…" />}

        {data && data.days.length === 0 && (
          <EmptyState title={`Nothing scheduled in the next ${days} days`} icon={CalendarRangeIcon}>
            <p>Add recurring or single-date availability above and it will show up here.</p>
          </EmptyState>
        )}

        {data?.days.map((day) => (
          <section key={day.date} aria-labelledby={`day-${day.date}`} className="space-y-3">
            <h3 id={`day-${day.date}`} className="flex items-center gap-2 border-b pb-2 text-sm font-semibold text-foreground">
              {formatDate(day.date, { weekday: 'long' })}
              {day.date === today && (
                <Badge variant="secondary" className="bg-accent text-accent-foreground">
                  Today
                </Badge>
              )}
            </h3>

            {day.exception && (
              <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <CalendarOffIcon className="size-4 shrink-0" aria-hidden />
                {day.exception.isAvailable
                  ? `Custom hours${day.exception.reason ? ` · ${day.exception.reason}` : ''}`
                  : day.exception.startTime && day.exception.endTime
                    ? `Blocked ${formatTimeRange(day.exception.startTime, day.exception.endTime)}${day.exception.reason ? ` · ${day.exception.reason}` : ''}`
                    : `Day off${day.exception.reason ? ` · ${day.exception.reason}` : ''}`}
              </p>
            )}

            {day.sessions.map((part, index) => {
              const open = part.slots.filter((slot) => slot.status === 'AVAILABLE');
              const places = open.reduce((sum, slot) => sum + (slot.remaining ?? 0), 0);
              const allPast = part.slots.length > 0 && part.slots.every((slot) => slot.status === 'PAST');
              return (
                <div key={`${part.availabilityId ?? 'exception'}:${part.startTime}:${index}`} className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                        {formatTimeRange(part.startTime, part.endTime)}
                        <ModeBadge mode={part.mode} />
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {part.slotMinutes}-minute slots · {part.mode === 'WAVE' ? `up to ${part.capacityPerSlot} patients each` : 'one patient per slot'} ·{' '}
                        {open.length} of {part.slots.length} open{part.mode === 'WAVE' ? `, ${places} places left` : ''}
                      </p>
                    </div>
                    {!allPast && part.source !== 'OVERRIDE' && (
                      <Button variant="outline" size="sm" onClick={() => setTarget({ day, session: part, slot: null })}>
                        {part.source === 'ONE_TIME' ? 'Delete session' : 'Cancel session'}
                      </Button>
                    )}
                  </div>
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label={`Slots, ${formatDate(day.date)}, ${formatTimeRange(part.startTime, part.endTime)}`}>
                    {part.slots.map((slot) => (
                      <li key={slot.startTime}>
                        <button
                          type="button"
                          disabled={slot.status === 'PAST'}
                          onClick={() => setTarget({ day, session: part, slot })}
                          className={cn(
                            'flex h-12 w-full flex-col items-center justify-center rounded-lg border text-xs font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default',
                            SLOT_CHIP_STYLES[slot.status],
                          )}
                        >
                          <span>{formatTimeRange(slot.startTime, slot.endTime, true)}</span>
                          <span className="text-[11px] font-medium">{slotLabel(slot, part)}</span>
                          {/* The visible text is the accessible name; this only adds what selecting does. */}
                          <span className="sr-only">. Select to cancel this slot.</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        ))}
      </CardContent>

      <ConfirmDialog
        open={target !== null}
        title={slotTarget ? 'Cancel this slot?' : target?.session.source === 'ONE_TIME' ? 'Delete this session?' : 'Cancel this session on this date?'}
        description={
          target &&
          `${formatDate(target.day.date, { weekday: 'long' })} · ${
            slotTarget ? formatTimeRange(slotTarget.startTime, slotTarget.endTime) : formatTimeRange(target.session.startTime, target.session.endTime)
          }`
        }
        confirmLabel={agreed ? 'Yes, delete it and ask patients' : slotTarget ? 'Cancel slot' : target?.session.source === 'ONE_TIME' ? 'Delete session' : 'Cancel session'}
        busy={busy}
        error={dialogError}
        unavailableReason={
          reason && (
            <>
              {reason}{' '}
              {reason.includes('Appointments first') && (
                <Link href="/doctor/appointments" className="font-medium underline underline-offset-2">
                  Go to Appointments
                </Link>
              )}
            </>
          )
        }
        onConfirm={() => void confirm()}
        onClose={close}
      >
        {!reason && (
          <p className="text-sm text-muted-foreground">
            {target?.session.source === 'ONE_TIME' && !slotTarget
              ? 'The whole one-time session is removed.'
              : 'Patients can no longer book this time. Nothing else on the day changes, and you can undo it by removing the exception under Date exceptions.'}
          </p>
        )}
      </ConfirmDialog>
    </Card>
  );
}
