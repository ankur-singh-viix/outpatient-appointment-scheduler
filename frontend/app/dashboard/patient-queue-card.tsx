'use client';

import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatTimeRange } from '@/lib/format';
import { queueApi } from '@/lib/queue-client';
import { aheadText, ordinal, patientMessage, queuePositionLabel } from '@/lib/queue-view';
import type { MyQueueEntry, Session } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useQueuePolling } from '../queue/use-queue-polling';
import { Freshness, QueueStatusPill, TokenBadge } from '../queue/queue-ui';

const TONE: Record<ReturnType<typeof patientMessage>['tone'], string> = {
  waiting: 'border-amber-200 bg-amber-50 text-amber-950',
  soon: 'border-teal-300 bg-teal-50 text-teal-950',
  now: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  done: 'border-sky-200 bg-sky-50 text-sky-950',
  attention: 'border-red-200 bg-red-50 text-red-950',
};

/**
 * The patient's live place in today's queue on the dashboard: token, ordinal position (e.g. 3rd in queue), patients ahead,
 * who is being served, and what to do next. Uses GET /queue/mine only (never other patients' details). Polls while they are
 * in the queue so the position updates as the front desk and doctor change statuses.
 */
export function PatientQueueCard({ session }: { session: Session }) {
  const queue = useQueuePolling<MyQueueEntry[]>(
    `queue-mine:${session.user.id}`,
    () => queueApi.mine(session),
    (latest) => {
      if (!latest || latest.length === 0) return 60_000;
      // Faster while waiting or being served so position stays current; slower once finished or only booked.
      const live = latest.some((entry) => entry.status === 'WAITING' || entry.status === 'SERVING');
      return live ? 8_000 : 30_000;
    },
  );

  if (queue.loading) {
    return (
      <section aria-label="Your place in the queue" aria-busy="true" className="space-y-3 rounded-xl border bg-card p-5">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-14 w-1/2" />
      </section>
    );
  }
  if (!queue.data) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={() => void queue.refresh()}>
            Retry
          </Button>
        }
      >
        Could not check your place in the queue. {queue.error}
      </Alert>
    );
  }
  if (queue.data.length === 0) return null;

  return (
    <div className="space-y-3">
      {queue.data.map((entry) => (
        <QueueEntryCard key={entry.id} entry={entry} />
      ))}
      <Freshness updatedAt={queue.updatedAt} stale={queue.stale} error={queue.error} onRetry={() => void queue.refresh()} />
    </div>
  );
}

function QueueEntryCard({ entry }: { entry: MyQueueEntry }) {
  const message = patientMessage(entry);
  const position = queuePositionLabel(entry);
  const waiting = entry.status === 'WAITING';
  const serving = entry.status === 'SERVING';
  const inLine = waiting || serving;

  return (
    <section aria-label="Your place in the queue" className="space-y-4 rounded-xl border-2 border-primary/30 bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">Your place in the queue</h2>
          <p className="text-sm text-muted-foreground">
            {entry.doctor.name} · appointment {formatTimeRange(entry.appointment.startTime, entry.appointment.endTime)}
          </p>
        </div>
        <QueueStatusPill status={entry.status} />
      </div>

      {position && (
        <p className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl" aria-live="polite">
          {position}
          {waiting && entry.ahead != null && entry.ahead > 0 && (
            <span className="mt-1 block text-base font-medium text-muted-foreground sm:mt-0 sm:ml-3 sm:inline">
              · {aheadText(entry.ahead)}
            </span>
          )}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Your token">
          <TokenBadge token={entry.token} size="xl" />
        </Figure>
        <Figure label="Now serving">
          {entry.currentlyServingToken === null ? (
            <span className="text-3xl font-bold text-muted-foreground">–</span>
          ) : (
            <TokenBadge token={entry.currentlyServingToken} size="lg" className="bg-emerald-700" />
          )}
        </Figure>
        <Figure label="Patients ahead">
          <span className="text-4xl font-bold tabular-nums text-foreground">
            {waiting && entry.ahead != null ? entry.ahead : serving ? 0 : '–'}
          </span>
          {waiting && entry.ahead != null && <span className="sr-only"> ({aheadText(entry.ahead)})</span>}
        </Figure>
        <Figure label="Your position">
          <span className="text-2xl font-bold tabular-nums text-foreground sm:text-3xl">
            {waiting && entry.ahead != null ? ordinal(entry.ahead + 1) : serving ? 'Now' : '–'}
          </span>
        </Figure>
      </div>

      <div role="status" aria-live="polite" className={cn('rounded-lg border p-4', TONE[message.tone])}>
        <p className="text-lg font-semibold">{message.headline}</p>
        <p className="mt-1 text-sm">{message.detail}</p>
        {inLine && (
          <p className="mt-2 text-xs font-medium text-current/80">This updates automatically as the queue moves.</p>
        )}
      </div>
    </section>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      <div className="flex min-h-14 items-center">{children}</div>
    </div>
  );
}
