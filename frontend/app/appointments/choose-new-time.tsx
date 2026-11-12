'use client';

import { CalendarSearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Alert, Spinner } from '@/components/common';
import { Button, buttonVariants } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatTime, formatTimeRange } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { AppointmentAlternatives, OpenTime, PatientAppointment, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

const label = (option: OpenTime) => `${formatTime(option.startTime)}${option.remaining > 1 ? ` (${option.remaining} places left)` : ''}`;

/**
 * The patient's way to settle an appointment that no longer fits the doctor's hours (or to move any upcoming one): real open times of
 * the same doctor, searched from today and listed nearest first, a page at a time, then an explicit confirmation before anything
 * changes. Moving goes through the normal reschedule, which re-checks the place under the doctor lock, so a time taken in the
 * meantime is refused and nothing is overbooked. Until they confirm, the appointment stays exactly as it was. When nothing is open
 * the panel says so plainly: the appointment stays booked, and there is a way to the full calendar and to the clinic.
 */
export function ChooseNewTime({ appointment: a, session, onMoved, onClose }: { appointment: PatientAppointment; session: Session; onMoved: () => void; onClose: () => void }) {
  const alternatives = useQuery(`alternatives:${a.id}`, () => api<AppointmentAlternatives>(`/appointments/${a.id}/alternatives`, { token: session.accessToken }));
  const [failure, setFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<OpenTime | null>(null);
  const [moving, setMoving] = useState(false);
  // Later pages, added after the first one. `cursor` is undefined until a page has been loaded here, then where the next one starts (null: no more).
  const [more, setMore] = useState<OpenTime[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const submitted = useRef(false);
  const data = alternatives.data ?? alternatives.previous ?? null;
  const loading = alternatives.loading;
  const error = failure ?? alternatives.error;

  const known = new Set<string>();
  const all = [...(data?.alternatives ?? []), ...more].filter((option) => {
    const key = `${option.date}|${option.startTime}`;
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  const nextCursor = cursor !== undefined ? cursor : (data?.nextCursor ?? null);
  const days = all.reduce<{ date: string; times: OpenTime[] }[]>((groups, option) => {
    const last = groups[groups.length - 1];
    if (last && last.date === option.date) last.times.push(option);
    else groups.push({ date: option.date, times: [option] });
    return groups;
  }, []);

  /** Back to a fresh first page: what is open now, after a time was taken or the doctor changed something. */
  const refresh = () => {
    setMore([]);
    setCursor(undefined);
    setMoreError(null);
    alternatives.reload();
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api<AppointmentAlternatives>(`/appointments/${a.id}/alternatives?cursor=${encodeURIComponent(nextCursor)}`, { token: session.accessToken });
      setMore((current) => [...current, ...page.alternatives]);
      setCursor(page.nextCursor);
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

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
      refresh(); // the time may have just been taken: show what is open now. The original appointment is untouched.
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
      {error && (
        <Alert>
          {error}
          {failure && ' Your original appointment has not changed. The list below is up to date.'}
        </Alert>
      )}
      {data && !data.needsNewTime && (
        <div className="space-y-1 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900" role="status">
          <p className="font-semibold">Your appointment fits {a.doctor.name}&apos;s hours again</p>
          <p>You do not need to choose a new time. It stays booked exactly as it was. You can still move it below if you would like a different time.</p>
        </div>
      )}
      {loading && !data && <Spinner label="Finding open times…" />}

      {data && all.length === 0 && (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950" role="status" aria-label="No time is open right now">
          <p className="font-semibold">No other time is open with {a.doctor.name} right now.</p>
          <p>
            Your appointment is still booked, exactly as it was. Nothing has been cancelled or moved. You do not need to do anything today: if new times open up we will email you, or you can check again later.
          </p>
          <p>
            You can also contact {a.clinic.name} ({a.clinic.address}) if you need help, or cancel the appointment below if no time will work for you.
          </p>
          <Button variant="outline" size="sm" onClick={refresh} disabled={alternatives.loading}>
            {alternatives.loading ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      )}

      {data && all.length > 0 && !picked && (
        <div className="space-y-3">
          <p className="text-muted-foreground">Open times, nearest first. Choose one to see the details before anything changes.</p>
          {days.map((group) => (
            <section key={group.date} aria-label={formatDate(group.date, { weekday: 'long' })} className="space-y-1.5">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{formatDate(group.date, { weekday: 'long' })}</h4>
              <ul className="flex flex-wrap gap-2" aria-label={`Open times on ${formatDate(group.date)}`}>
                {group.times.map((option) => (
                  <li key={`${option.date}-${option.startTime}`}>
                    <Button variant="outline" size="lg" className="h-9" onClick={() => setPicked(option)}>
                      {label(option)}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {moreError && <Alert>{moreError}</Alert>}
          {nextCursor ? (
            <Button variant="outline" size="lg" className="h-9" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? 'Loading…' : 'Show more times'}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">That is every open time until {formatDate(data.searchedUntil)}.</p>
          )}
        </div>
      )}

      {picked && (
        <div className={cn('space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3')} role="group" aria-label="Confirm the move">
          <p className="text-foreground">
            Move your appointment from <span className="font-medium">{formatDate(a.date, { weekday: 'short' })} · {formatTimeRange(a.startTime, a.endTime)}</span> to{' '}
            <span className="font-medium">{formatDate(picked.date, { weekday: 'short' })} · {formatTime(picked.startTime)}</span>? Your booking and any payment move with it. Nothing changes until you confirm.
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

      <Link href={`/doctors/${a.doctor.id}?reschedule=${a.id}`} className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-9 gap-2' })}>
        <CalendarSearchIcon aria-hidden /> Browse every date in the calendar
      </Link>
    </div>
  );
}
