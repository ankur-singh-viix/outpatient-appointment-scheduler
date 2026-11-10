'use client';

import { useRef, useState } from 'react';
import { Alert, Spinner } from '@/components/common';
import { useQuery } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatTime, formatTimeRange } from '@/lib/format';
import type { AppointmentAlternatives, OpenTime, PatientAppointment, Session } from '@/lib/types';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

const label = (option: OpenTime) => `${formatDate(option.date, { weekday: 'short' })} · ${formatTime(option.startTime)}${option.remaining > 1 ? ` (${option.remaining} places left)` : ''}`;

/**
 * The patient's way to settle an appointment that no longer fits the doctor's hours (or to move any upcoming one): real open
 * times of the same doctor, nearest first, then an explicit confirmation before anything changes. Moving goes through the normal
 * reschedule, which re-checks the place under the doctor lock, so a time taken in the meantime is refused and nothing is
 * overbooked. Until they confirm, the appointment stays exactly as it was.
 */
export function ChooseNewTime({ appointment: a, session, onMoved, onClose }: { appointment: PatientAppointment; session: Session; onMoved: () => void; onClose: () => void }) {
  const alternatives = useQuery(`alternatives:${a.id}`, () => api<AppointmentAlternatives>(`/appointments/${a.id}/alternatives`, { token: session.accessToken }));
  const [failure, setFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<OpenTime | null>(null);
  const [moving, setMoving] = useState(false);
  const submitted = useRef(false);
  const data = alternatives.data ?? alternatives.previous ?? null;
  const loading = alternatives.loading;
  const error = failure ?? alternatives.error;

  const confirm = async () => {
    if (!picked || submitted.current) return; // a double click sends one request
    submitted.current = true;
    setMoving(true);
    setFailure(null);
    try {
      await api(`/appointments/${a.id}/reschedule`, { method: 'POST', token: session.accessToken, body: { date: picked.date, startTime: picked.startTime } });
      onMoved();
    } catch (err) {
      setFailure(errorMessage(err));
      setPicked(null);
      submitted.current = false;
      setMoving(false);
      alternatives.reload(); // the time may have just been taken: show what is open now
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3 text-sm" role="group" aria-label="Choose a new time">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-foreground">Pick a new time with {a.doctor.name}</p>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={moving}>
          Close
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {data && !data.needsNewTime && (
        <div className="space-y-1 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900" role="status">
          <p className="font-semibold">Your appointment fits {a.doctor.name}&apos;s hours again</p>
          <p>You do not need to choose a new time. It stays booked exactly as it was. You can still move it below if you would like a different time.</p>
        </div>
      )}
      {loading && !data && <Spinner label="Finding open times…" />}
      {data && data.alternatives.length === 0 && (
        <div className="space-y-2 text-foreground/80" role="status">
          <p className="font-medium text-foreground">No other time is open with {a.doctor.name} right now.</p>
          <p>
            Your appointment is still booked and nothing has changed. You can check again later, contact {a.clinic.name}, or cancel it below if none of the times will work.
          </p>
        </div>
      )}
      {data && data.alternatives.length > 0 && !picked && (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Open times">
          {data.alternatives.map((option) => (
            <li key={`${option.date}-${option.startTime}`}>
              <Button variant="outline" size="lg" className="h-9 w-full justify-start" onClick={() => setPicked(option)}>
                {label(option)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {picked && (
        <div className={cn('space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3')} role="group" aria-label="Confirm the move">
          <p className="text-foreground">
            Move your appointment from <span className="font-medium">{formatDate(a.date, { weekday: 'short' })} · {formatTimeRange(a.startTime, a.endTime)}</span> to{' '}
            <span className="font-medium">{formatDate(picked.date, { weekday: 'short' })} · {formatTime(picked.startTime)}</span>? Your booking and any payment move with it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" className="h-9" disabled={moving} onClick={() => void confirm()}>
              {moving ? 'Moving…' : 'Confirm move'}
            </Button>
            <Button variant="outline" size="lg" className="h-9" disabled={moving} onClick={() => setPicked(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
      <Link href={`/doctors/${a.doctor.id}?reschedule=${a.id}`} className={buttonVariants({ variant: 'link', size: 'sm', className: 'px-0' })}>
        See every available date
      </Link>
    </div>
  );
}
