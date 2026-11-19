'use client';

import { CheckIcon, ClipboardListIcon, PhoneCallIcon, SkipForwardIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { useNow } from '@/lib/hooks';
import { queueApi } from '@/lib/queue-client';
import { STATUS_LABEL, actionNotice, canCallNext, doctorCheckInDetail, entryActions, type QueueAction } from '@/lib/queue-view';
import type { DoctorQueue, QueueEntryResult, QueueEntryView, Session } from '@/lib/types';
import { useQueuePolling } from '../queue/use-queue-polling';
import { Freshness, QueueStatusPill, TokenBadge } from '../queue/queue-ui';
import { PatientHistoryPanel } from './patient-history-panel';

/**
 * The doctor's live queue: who is being seen, who is waiting after check-in (earliest check-in first), Complete consultation, and
 * Skip when a patient is unavailable. Polls the existing doctor queue API; booking, check-in and checkout stay with reception.
 */
export function DoctorQueuePanel({ session }: { session: Session }) {
  const queue = useQueuePolling<DoctorQueue>(`queue-doctor:${session.user.id}`, () => queueApi.doctorQueue(session), 8_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [historyPatient, setHistoryPatient] = useState<{ id: string; name: string } | null>(null);
  // Refresh often enough that waiting duration stays current between poll rounds.
  const now = useNow(10_000);

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
  // Only checked-in WAITING patients — never BOOKED / cancelled / no-show / checked-out rows.
  const waiting = (day?.waiting ?? []).filter((entry) => entry.status === 'WAITING' && entry.checkedInAt);

  return (
    <section aria-labelledby="queue-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="queue-heading" className="text-lg font-semibold text-foreground">
          Live queue
        </h2>
        {day && (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Serving {day.currentlyServingToken ?? '–'} · {day.counts.completed + day.counts.checkedOut} completed
            {day.counts.skipped > 0 ? ` · ${day.counts.skipped} skipped` : ''}
          </p>
        )}
      </div>
      {day && (
        <div className="grid grid-cols-2 gap-2 sm:max-w-md">
          <QueueStat label="Serving token" value={day.currentlyServingToken ?? '–'} />
          <QueueStat label="Completed" value={day.counts.completed + day.counts.checkedOut} />
        </div>
      )}

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
          <NowServing
            day={day}
            waiting={waiting}
            now={now}
            busy={busy}
            onComplete={(entry) => void act(entry.id, 'complete', () => queueApi.complete(session, entry.id))}
            onSkip={(entry) => void act(entry.id, 'skip', () => queueApi.skipAsDoctor(session, entry.id))}
            onCallNext={() => void act('call-next', 'callNext', () => queueApi.callNext(session))}
            onViewHistory={(entry) => entry.patient.id && setHistoryPatient({ id: entry.patient.id, name: entry.patient.name })}
          />

          <div className="rounded-xl border bg-card">
            <div className="border-b px-4 py-3">
              <h3 className="font-semibold text-foreground">Waiting</h3>
            </div>
            {waiting.length === 0 ? (
              <div className="p-4">
                <EmptyState title="Nobody is waiting" icon={UsersIcon}>
                  Patients appear here, in token order, after the front desk checks them in.
                </EmptyState>
              </div>
            ) : (
              <ol className="divide-y">
                {waiting.map((entry, index) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <TokenBadge token={entry.token} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">
                        {entry.patient.name}
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                          {index === 0 ? 'Next' : `#${index + 1} in line`}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground" aria-live="polite">
                        {doctorCheckInDetail(entry, now) ?? 'Checked in'}
                      </p>
                    </div>
                    <QueueStatusPill status={entry.status} />
                    <div className="flex flex-wrap gap-2">
                      {entry.patient.id && (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`View medical and visit history for ${entry.patient.name}`}
                          onClick={() => setHistoryPatient({ id: entry.patient.id!, name: entry.patient.name })}
                        >
                          <ClipboardListIcon aria-hidden /> History
                        </Button>
                      )}
                      {entryActions('DOCTOR', entry.status).includes('skip') && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          aria-label={`Skip token ${entry.token}, ${entry.patient.name}`}
                          onClick={() => void act(entry.id, 'skip', () => queueApi.skipAsDoctor(session, entry.id))}
                        >
                          <SkipForwardIcon aria-hidden /> Skip
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {day.skipped.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Skipped: {day.skipped.map((entry) => `${entry.token} (${entry.patient.name})`).join(', ')}. The front desk returns a
              skipped patient to the queue.
            </p>
          )}
        </>
      )}

      <PatientHistoryPanel
        session={session}
        patientId={historyPatient?.id ?? null}
        patientName={historyPatient?.name}
        open={historyPatient != null}
        onClose={() => setHistoryPatient(null)}
      />
    </section>
  );
}

function NowServing({
  day,
  waiting,
  now,
  busy,
  onCallNext,
  onComplete,
  onSkip,
  onViewHistory,
}: {
  day: DoctorQueue;
  waiting: QueueEntryView[];
  now: number;
  busy: string | null;
  onCallNext: () => void;
  onComplete: (entry: QueueEntryView) => void;
  onSkip: (entry: QueueEntryView) => void;
  onViewHistory: (entry: QueueEntryView) => void;
}) {
  const serving = day.serving;
  if (serving) {
    return (
      <div className="space-y-3 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-5">
        <p className="text-xs font-semibold tracking-wide text-emerald-800 uppercase">Now serving</p>
        <div className="flex flex-wrap items-center gap-4">
          <TokenBadge token={serving.token} size="xl" className="bg-emerald-700" />
          <div className="min-w-0 flex-1">
            <p className="text-xl font-semibold text-foreground">{serving.patient.name}</p>
            <p className="text-sm text-emerald-900" aria-live="polite">
              {doctorCheckInDetail(serving, now) ?? STATUS_LABEL.SERVING}
              {' · '}
              {STATUS_LABEL[serving.status]}
            </p>
          </div>
          <QueueStatusPill status={serving.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          {entryActions('DOCTOR', 'SERVING').includes('complete') && (
            <Button size="lg" className="h-10" disabled={busy !== null} onClick={() => onComplete(serving)}>
              <CheckIcon aria-hidden /> {busy === serving.id ? 'Working…' : 'Complete consultation'}
            </Button>
          )}
          {serving.patient.id && (
            <Button size="lg" variant="outline" className="h-10" onClick={() => onViewHistory(serving)}>
              <ClipboardListIcon aria-hidden /> View medical history
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            className="h-10"
            disabled={busy !== null}
            aria-label={`Skip token ${serving.token}, ${serving.patient.name}: not available`}
            onClick={() => onSkip(serving)}
          >
            <SkipForwardIcon aria-hidden /> Not available: skip
          </Button>
        </div>
      </div>
    );
  }
  const next = waiting[0];
  return (
    <div className="space-y-3 rounded-xl border bg-card p-5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Now serving</p>
      <p className="text-sm text-muted-foreground">
        {canCallNext({ serving: null, waiting }) ? 'Nobody is being seen right now.' : 'Nobody is being seen, and nobody is waiting.'}
      </p>
      <Button size="lg" className="h-11" disabled={!canCallNext({ serving: null, waiting }) || busy !== null} onClick={onCallNext}>
        <PhoneCallIcon aria-hidden /> {busy === 'call-next' ? 'Calling…' : next ? `Call next patient (token ${next.token})` : 'Call next patient'}
      </Button>
    </div>
  );
}

function QueueStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
