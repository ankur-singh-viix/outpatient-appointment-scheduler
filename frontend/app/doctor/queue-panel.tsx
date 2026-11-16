'use client';

import { CheckIcon, PhoneCallIcon, SkipForwardIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { formatTimeRange, timeAgo } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { queueApi } from '@/lib/queue-client';
import { actionNotice, canCallNext, entryActions, progress, type QueueAction } from '@/lib/queue-view';
import type { DoctorQueue, QueueEntryResult, QueueEntryView, Session } from '@/lib/types';
import { useQueuePolling } from '../queue/use-queue-polling';
import { Freshness, TokenBadge } from '../queue/queue-ui';

/**
 * The doctor's queue management: who is being seen, who is waiting (in token order), and the three things a doctor does: call the next
 * patient, complete the consultation, and skip a patient who is unavailable. It shows only this doctor's queue (the server decides
 * whose it is from the sign-in), keeps itself up to date by polling, and shows the server's own message when an action is refused.
 */
export function DoctorQueuePanel({ session }: { session: Session }) {
  const queue = useQueuePolling<DoctorQueue>(`queue-doctor:${session.user.id}`, () => queueApi.doctorQueue(session), 8_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const now = useNow(15_000);

  const act = async (key: string, action: QueueAction | 'callNext', run: () => Promise<QueueEntryResult>) => {
    if (busy) return; // one action at a time: a double click sends one request
    setBusy(key);
    setNotice(null);
    try {
      setNotice({ tone: 'success', text: actionNotice(action, await run()) });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
      await queue.refresh(); // whatever happened, show the queue as it is now
    }
  };

  const day = queue.data;
  return (
    <section aria-labelledby="queue-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="queue-heading" className="text-lg font-semibold text-foreground">
          Queue management
        </h2>
        {day && (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {day.counts.waiting} waiting · {day.counts.completed + day.counts.checkedOut} seen
            {day.counts.skipped > 0 ? ` · ${day.counts.skipped} skipped` : ''}
          </p>
        )}
      </div>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {queue.loading && (
        <div aria-busy="true" className="space-y-3 rounded-xl border bg-card p-5">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-12 w-1/2" />
        </div>
      )}

      {!day && !queue.loading && (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={() => void queue.refresh()}>
              Try again
            </Button>
          }
        >
          Could not load your queue. {queue.error}
        </Alert>
      )}

      {day && (
        <>
          <Freshness updatedAt={queue.updatedAt} stale={queue.stale} error={queue.error} onRetry={() => void queue.refresh()} />
          <NowServing day={day} busy={busy} onComplete={(entry) => void act(entry.id, 'complete', () => queueApi.complete(session, entry.id))} onSkip={(entry) => void act(entry.id, 'skip', () => queueApi.skipAsDoctor(session, entry.id))} onCallNext={() => void act('call-next', 'callNext', () => queueApi.callNext(session))} />

          <div className="rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h3 className="font-semibold text-foreground">Waiting ({day.waiting.length})</h3>
              <Progress day={day} />
            </div>
            {day.waiting.length === 0 ? (
              <div className="p-4">
                <EmptyState title="Nobody is waiting" icon={UsersIcon}>
                  Patients appear here, in token order, as the front desk checks them in.
                </EmptyState>
              </div>
            ) : (
              <ol className="divide-y">
                {day.waiting.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <TokenBadge token={entry.token} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">
                        {entry.patient.name} <span className="text-sm font-normal text-muted-foreground">· {entry.position === 1 ? 'next' : `#${entry.position} in line`}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Appointment {formatTimeRange(entry.appointment.startTime, entry.appointment.endTime, true)} · waiting since {timeAgo(entry.checkedInAt, now)}
                      </p>
                    </div>
                    {entryActions('DOCTOR', entry.status).includes('skip') && (
                      <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`Skip token ${entry.token}, ${entry.patient.name}`} onClick={() => void act(entry.id, 'skip', () => queueApi.skipAsDoctor(session, entry.id))}>
                        <SkipForwardIcon aria-hidden /> Skip
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {day.skipped.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Skipped: {day.skipped.map((entry) => `${entry.token} (${entry.patient.name})`).join(', ')}. The front desk returns a skipped patient to the queue.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function NowServing({ day, busy, onCallNext, onComplete, onSkip }: { day: DoctorQueue; busy: string | null; onCallNext: () => void; onComplete: (entry: QueueEntryView) => void; onSkip: (entry: QueueEntryView) => void }) {
  const serving = day.serving;
  if (serving) {
    return (
      <div className="space-y-3 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-5">
        <p className="text-xs font-semibold tracking-wide text-emerald-800 uppercase">Now serving</p>
        <div className="flex flex-wrap items-center gap-4">
          <TokenBadge token={serving.token} size="xl" className="bg-emerald-700" />
          <div className="min-w-0 flex-1">
            <p className="text-xl font-semibold text-foreground">{serving.patient.name}</p>
            <p className="text-sm text-emerald-900">Appointment {formatTimeRange(serving.appointment.startTime, serving.appointment.endTime)}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {entryActions('DOCTOR', 'SERVING').includes('complete') && (
            <Button size="lg" className="h-10" disabled={busy !== null} onClick={() => onComplete(serving)}>
              <CheckIcon aria-hidden /> {busy === serving.id ? 'Working…' : 'Complete consultation'}
            </Button>
          )}
          <Button size="lg" variant="outline" className="h-10" disabled={busy !== null} aria-label={`Skip token ${serving.token}, ${serving.patient.name}: not available`} onClick={() => onSkip(serving)}>
            <SkipForwardIcon aria-hidden /> Not available: skip
          </Button>
        </div>
      </div>
    );
  }
  const next = day.waiting[0];
  return (
    <div className="space-y-3 rounded-xl border bg-card p-5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Now serving</p>
      <p className="text-sm text-muted-foreground">{canCallNext(day) ? 'Nobody is being seen right now.' : 'Nobody is being seen, and nobody is waiting.'}</p>
      <Button size="lg" className="h-11" disabled={!canCallNext(day) || busy !== null} onClick={onCallNext}>
        <PhoneCallIcon aria-hidden /> {busy === 'call-next' ? 'Calling…' : next ? `Call next patient (token ${next.token})` : 'Call next patient'}
      </Button>
    </div>
  );
}

function Progress({ day }: { day: DoctorQueue }) {
  const { total, done, percent } = progress(day.counts);
  if (total === 0) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-label={`${done} of ${total} patients seen`}>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      {done}/{total} seen
    </div>
  );
}
