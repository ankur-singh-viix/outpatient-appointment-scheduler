'use client';

import { ArrowRightIcon, ClockIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, Spinner } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatTime, formatTimeRange } from '@/lib/format';
import { useClinicToday, useDebounced, useQuery } from '@/lib/hooks';
import type { HoursChangePreview, SchedulingMode, Session } from '@/lib/types';
import { cn } from '@/lib/utils';
import { restoredNote } from './restored-note';

/** The session whose hours are being changed. */
export interface AdjustTarget {
  id: string;
  /** "Monday" for a recurring session, "Thursday, 12 Nov 2026" for one date. */
  title: string;
  recurring: boolean;
  startTime: string;
  endTime: string;
  mode: SchedulingMode;
  /** "30-minute slots · up to 3 patients each", shown so it is clear that only the hours change. */
  settings: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Change the hours of a session that may already have bookings. The server works out the effect with the same rules booking uses,
 * and this shows it before anything is saved: the hours now and proposed, the patients affected, and anything that cannot be
 * done (with the nearest start times that can).
 *
 * Extending only adds slots. Reducing leaves booked appointments outside the hours: they are listed here first, they stay booked,
 * and saving needs the doctor's explicit agreement. Each patient is then emailed and asked to choose a new time, which is their
 * confirmation; nobody is moved or cancelled by this dialog.
 */
export function AdjustHoursDialog({ session, target, onClose, onApplied }: { session: Session; target: AdjustTarget | null; onClose: () => void; onApplied: (message: string) => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        {/* Keyed by session, so each one starts from its own hours. */}
        {target && <AdjustForm key={target.id} session={session} target={target} onClose={onClose} onApplied={onApplied} />}
      </DialogContent>
    </Dialog>
  );
}

function AdjustForm({ session, target, onClose, onApplied }: { session: Session; target: AdjustTarget; onClose: () => void; onApplied: (message: string) => void }) {
  const today = useClinicToday();
  const [start, setStart] = useState(target.startTime);
  const [end, setEnd] = useState(target.endTime);
  const [applyFrom, setApplyFrom] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ask the server about the proposed hours once the doctor pauses typing.
  const wanted = useDebounced(`${start}|${end}|${applyFrom}`, 350);
  const [wantedStart, wantedEnd, wantedFrom] = wanted.split('|');
  const ready = Boolean(wantedStart && wantedEnd) && wanted === `${start}|${end}|${applyFrom}`;
  const preview = useQuery(wantedStart && wantedEnd ? `hours-preview:${target.id}:${wanted}` : null, () =>
    api<HoursChangePreview>(`/doctor-portal/availability/${target.id}/change/preview`, {
      method: 'POST',
      token: session.accessToken,
      body: { startTime: wantedStart, endTime: wantedEnd, ...(target.recurring && wantedFrom ? { applyFrom: wantedFrom } : {}) },
    }),
  );
  const shown = preview.data;
  const settled = ready && shown !== undefined && !preview.loading;
  const affected = settled && shown ? shown.affectedAppointments : [];
  // The list shows the first few; the count covers every affected appointment.
  const affectedTotal = settled && shown ? shown.affectedCount : 0;
  const needsAgreement = affectedTotal > 0;
  // Extending: appointments that were waiting for a new time and would be inside the hours again.
  const restoredTotal = settled && shown ? shown.restoredCount : 0;
  const restored = settled && shown ? shown.restoredAppointments : [];

  const apply = async () => {
    if (!shown?.canApply || (needsAgreement && !agreed)) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api<{ restoredAppointments?: number }>(`/doctor-portal/availability/${target.id}/change`, {
        method: 'POST',
        token: session.accessToken,
        body: {
          startTime: start,
          endTime: end,
          from: { startTime: target.startTime, endTime: target.endTime },
          ...(target.recurring && applyFrom ? { applyFrom } : {}),
          ...(needsAgreement ? { acknowledge: true } : {}),
        },
      });
      const parts = [`hours changed to ${formatTimeRange(start, end)}`];
      if (shown.addedSlots) parts.push(`${plural(shown.addedSlots, 'new slot')} open for booking`);
      if (shown.removedSlots) parts.push(`${plural(shown.removedSlots, 'slot')} closed to new bookings`);
      onApplied(
        `${target.title}: ${parts.join(', ')}.${needsAgreement ? ` ${plural(affectedTotal, 'patient')} ${affectedTotal === 1 ? 'is being' : 'are being'} asked to choose a new time; their appointments stay booked until they do.` : ''}${restoredNote(done.restoredAppointments)}`,
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const unchanged = start === target.startTime && end === target.endTime;

  return (
    <div className="space-y-5">
      <div>
        <DialogTitle>Adjust hours · {target.title}</DialogTitle>
        <DialogDescription>
          Change when this session runs. The slot length and places per slot stay the same ({target.settings}). Nobody who has booked is moved or cancelled by this.
        </DialogDescription>
      </div>

      <div className="grid items-center gap-3 rounded-xl bg-muted/60 p-4 sm:grid-cols-[1fr_auto_1fr]">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Now</p>
          <p className="text-base font-semibold text-foreground">{formatTimeRange(target.startTime, target.endTime)}</p>
        </div>
        <ArrowRightIcon className="hidden size-5 text-muted-foreground sm:block" aria-hidden />
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Proposed</p>
          <p className={cn('text-base font-semibold', unchanged ? 'text-muted-foreground' : 'text-primary')}>{start && end ? formatTimeRange(start, end) : '—'}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="adjust-start">New start time</Label>
          <Input id="adjust-start" type="time" required value={start} onChange={(event) => setStart(event.target.value)} className="h-10" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="adjust-end">New end time</Label>
          <Input id="adjust-end" type="time" required value={end} onChange={(event) => setEnd(event.target.value)} className="h-10" />
        </div>
        {target.recurring && (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="adjust-from">Apply from (optional)</Label>
            <Input id="adjust-from" type="date" min={today ?? undefined} value={applyFrom} onChange={(event) => setApplyFrom(event.target.value)} className="h-10 sm:max-w-xs" aria-describedby="adjust-from-hint" />
            <p id="adjust-from-hint" className="text-xs text-muted-foreground">
              Leave empty to start today. Earlier dates keep the hours they had, and date exceptions you have set are left alone.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-3" aria-live="polite">
        {!settled && !unchanged && <Spinner label="Working out the effect…" />}
        {preview.error && <Alert>{preview.error}</Alert>}
        {settled && shown && !unchanged && (
          <>
            {needsAgreement && (
              <section aria-labelledby="affected-heading" className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 id="affected-heading" className="text-sm font-semibold text-foreground">
                    Affected patients
                  </h3>
                  <span className="text-sm text-muted-foreground">{affectedTotal} in total</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Their appointments stay booked. After you save, each patient is emailed and chooses a new time themselves; nobody is moved or cancelled automatically.
                </p>
                <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border bg-card" aria-label="Affected patients">
                  {affected.map((appointment) => (
                    <li key={appointment.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">{appointment.patient.name}</p>
                        <p className="text-muted-foreground">
                          {formatDate(appointment.date, { weekday: 'short' })} · {formatTimeRange(appointment.startTime, appointment.endTime)}
                        </p>
                      </div>
                      <Badge variant="secondary" className={appointment.status === 'PENDING' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}>
                        {appointment.status === 'PENDING' ? 'Pending payment' : 'Confirmed'}
                      </Badge>
                    </li>
                  ))}
                </ul>
                {affectedTotal > affected.length && <p className="text-xs text-muted-foreground">Showing the first {affected.length}. The other {affectedTotal - affected.length} are asked the same way.</p>}
                <label className="flex items-start gap-2 text-sm font-medium">
                  <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-1 size-4 shrink-0 accent-primary" />
                  <span>I understand these appointments stay booked until each patient chooses a new time, and that nobody is moved or cancelled automatically.</span>
                </label>
              </section>
            )}
            {shown.problems.length > 0 && (
              <Alert>
                <span className="block font-medium">This change cannot be made yet:</span>
                <ul className="mt-1 list-disc pl-5">
                  {shown.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {shown.suggestedStarts.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Start at</span>
                {shown.suggestedStarts.map((suggestion) => (
                  <Button key={suggestion} type="button" variant="outline" size="sm" onClick={() => setStart(suggestion)}>
                    {formatTime(suggestion)}
                  </Button>
                ))}
              </div>
            )}
            {shown.canApply && restoredTotal > 0 && (
              <section aria-labelledby="restored-heading" className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950">
                <h3 id="restored-heading" className="font-semibold">
                  {plural(restoredTotal, 'booked appointment')} {restoredTotal === 1 ? 'is' : 'are'} back inside your hours
                </h3>
                <p>
                  {restoredTotal === 1 ? 'This patient was' : 'These patients were'} waiting to choose a new time. After you save, they do not need to: the appointment
                  stays exactly as booked, and a request that has not been sent yet is withdrawn. Nothing is moved, changed or refunded.
                </p>
                <ul className="max-h-40 divide-y divide-emerald-200 overflow-y-auto rounded-lg bg-white/70" aria-label="Appointments back inside your hours">
                  {restored.map((appointment) => (
                    <li key={appointment.id} className="flex flex-wrap items-center gap-x-2 p-2.5 font-medium text-foreground">
                      {appointment.patient.name}
                      <span className="font-normal text-muted-foreground">
                        {formatDate(appointment.date, { weekday: 'short' })} · {formatTimeRange(appointment.startTime, appointment.endTime)}
                      </span>
                    </li>
                  ))}
                </ul>
                {restoredTotal > restored.length && <p className="text-muted-foreground">Showing the first {restored.length}. The other {restoredTotal - restored.length} are released the same way.</p>}
              </section>
            )}

          </>
        )}
        {unchanged && <p className="text-sm text-muted-foreground">Change the start or end time to see what it would do.</p>}
        {error && <Alert>{error}</Alert>}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="lg" className="h-9" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" size="lg" className="h-9 gap-2" disabled={busy || !settled || !shown?.canApply || unchanged || (needsAgreement && !agreed)} onClick={() => void apply()}>
          <ClockIcon aria-hidden />
          {busy ? 'Applying…' : needsAgreement ? 'Reduce hours and ask patients' : 'Apply change'}
        </Button>
      </div>
    </div>
  );
}
