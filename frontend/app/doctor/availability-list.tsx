'use client';

import { CalendarDaysIcon, PencilIcon, RepeatIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState } from '@/components/common';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { DAY_LONG, WEEK_ORDER, formatDate, formatTimeRange } from '@/lib/format';
import type { AvailabilityRow, DoctorAvailability, OneTimeSession, SchedulingMode, Session, WeeklyHours } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MODE_LABEL, describeSettings, sessionBody } from './availability-model';

/** Stream and Wave get different tints, and always the word as well, so colour is never the only cue. */
export function ModeBadge({ mode }: { mode: SchedulingMode }) {
  return (
    <Badge variant="secondary" className={cn('font-semibold', mode === 'WAVE' ? 'bg-sky-50 text-sky-800' : 'bg-accent text-accent-foreground')}>
      {MODE_LABEL[mode]}
    </Badge>
  );
}

type Feedback = { tone: 'success' | 'error'; message: string } | null;
type Removing = { kind: 'weekly'; row: WeeklyHours } | { kind: 'oneoff'; row: OneTimeSession } | null;

function effectiveText(row: AvailabilityRow): string | null {
  if (!row.effectiveFrom && !row.effectiveTo) return null;
  return `${row.effectiveFrom ? `From ${formatDate(row.effectiveFrom)}` : 'Until'}${row.effectiveTo ? `${row.effectiveFrom ? ' until' : ''} ${formatDate(row.effectiveTo)}` : ''}`;
}

/**
 * Everything the doctor has set up, in two groups: recurring sessions (by weekday) and single dates. Each can be removed after a
 * confirmation; recurring ones can also be edited in the builder above.
 */
export function AvailabilityList({
  session,
  availability,
  editingId,
  onEdit,
  onChanged,
}: {
  session: Session;
  availability: DoctorAvailability;
  editingId: string | null;
  onEdit: (row: WeeklyHours) => void;
  onChanged: () => void;
}) {
  const [removing, setRemoving] = useState<Removing>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const minutes = availability.consultationMinutes;

  const close = () => {
    setRemoving(null);
    setDialogError(null);
  };

  const confirm = async () => {
    if (!removing) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (removing.kind === 'weekly') {
        const kept = availability.weekly.filter((row) => row.id !== removing.row.id);
        await api('/doctor-portal/availability/weekly', {
          method: 'PUT',
          token: session.accessToken,
          body: { hours: kept.map((row) => ({ dayOfWeek: row.dayOfWeek, ...sessionBody(row, minutes) })) },
        });
        setFeedback({ tone: 'success', message: `Removed the ${DAY_LONG[removing.row.dayOfWeek]} session. Patients can no longer book that time.` });
      } else {
        await api(`/doctor-portal/availability/one-time/${removing.row.id}`, { method: 'DELETE', token: session.accessToken });
        setFeedback({ tone: 'success', message: `Deleted the session on ${formatDate(removing.row.date)}.` });
      }
      close();
      onChanged();
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const nothing = availability.weekly.length === 0 && availability.oneTime.length === 0;

  return (
    <Card className="[--card-spacing:--spacing(6)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Your availability
        </CardTitle>
        <CardDescription>What patients can currently book. Remove a session to stop new bookings; appointments already made stay on your calendar.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}

        {nothing ? (
          <EmptyState title="No availability yet" icon={CalendarDaysIcon}>
            <p>Patients cannot book you until you add some. Use “Add availability” to set weekly hours or a single date.</p>
          </EmptyState>
        ) : (
          <>
            <section aria-labelledby="recurring-heading" className="space-y-3">
              <h3 id="recurring-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <RepeatIcon className="size-4 text-primary" aria-hidden /> Recurring
              </h3>
              {availability.weekly.length === 0 ? (
                <p className="text-sm text-muted-foreground">No weekly sessions.</p>
              ) : (
                <ul className="divide-y rounded-xl border bg-card" aria-label="Recurring sessions">
                  {WEEK_ORDER.flatMap((day) => availability.weekly.filter((row) => row.dayOfWeek === day)).map((row) => (
                    <li key={row.id} className={cn('flex flex-wrap items-center justify-between gap-3 p-4', editingId === row.id && 'bg-accent/40')}>
                      <div className="min-w-0 space-y-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                          {DAY_LONG[row.dayOfWeek]} · {formatTimeRange(row.startTime, row.endTime)}
                          <ModeBadge mode={row.schedulingMode} />
                        </p>
                        <p className="text-sm text-muted-foreground">{describeSettings(row, minutes)}</p>
                        {effectiveText(row) && <p className="text-xs text-muted-foreground">{effectiveText(row)}</p>}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => onEdit(row)} aria-label={`Edit ${DAY_LONG[row.dayOfWeek]} session`}>
                          <PencilIcon aria-hidden /> Edit
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setRemoving({ kind: 'weekly', row })} aria-label={`Remove ${DAY_LONG[row.dayOfWeek]} session`}>
                          <Trash2Icon aria-hidden /> Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="oneoff-heading" className="space-y-3">
              <h3 id="oneoff-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CalendarDaysIcon className="size-4 text-primary" aria-hidden /> Non-recurring
              </h3>
              {availability.oneTime.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sessions on single dates.</p>
              ) : (
                <ul className="divide-y rounded-xl border bg-card" aria-label="Non-recurring sessions">
                  {availability.oneTime.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0 space-y-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                          {formatDate(row.date, { weekday: 'long' })} · {formatTimeRange(row.startTime, row.endTime)}
                          <ModeBadge mode={row.schedulingMode} />
                        </p>
                        <p className="text-sm text-muted-foreground">{describeSettings(row, minutes)}</p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setRemoving({ kind: 'oneoff', row })} aria-label={`Delete the session on ${formatDate(row.date)}`}>
                        <Trash2Icon aria-hidden /> Delete
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={removing !== null}
        title={removing?.kind === 'weekly' ? `Remove this ${DAY_LONG[removing.row.dayOfWeek]} session?` : 'Delete this session?'}
        description={
          removing &&
          (removing.kind === 'weekly'
            ? `${DAY_LONG[removing.row.dayOfWeek]} ${formatTimeRange(removing.row.startTime, removing.row.endTime)} will stop repeating. Patients can no longer book it; appointments already made are kept.`
            : `${formatDate(removing.row.date, { weekday: 'long' })} ${formatTimeRange(removing.row.startTime, removing.row.endTime)} will be deleted. If patients have booked it, you will need to cancel those appointments first.`)
        }
        confirmLabel={removing?.kind === 'weekly' ? 'Remove session' : 'Delete session'}
        busy={busy}
        error={dialogError}
        onConfirm={() => void confirm()}
        onClose={close}
      />
    </Card>
  );
}
