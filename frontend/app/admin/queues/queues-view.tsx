'use client';

import { ListOrderedIcon } from 'lucide-react';
import { Alert, EmptyState, PageHeader, Spinner } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate } from '@/lib/format';
import { queueApi } from '@/lib/queue-client';
import { adminTotals } from '@/lib/queue-view';
import type { AdminQueueBoard, Session } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useQueuePolling } from '../../queue/use-queue-polling';
import { Freshness, TokenBadge } from '../../queue/queue-ui';

export function AdminQueuesPage() {
  return (
    <RequireRole role="ADMIN" nextPath="/admin/queues">
      {(session) => <Queues session={session} />}
    </RequireRole>
  );
}

const STATUS_TEXT = { SERVING: 'In consultation', WAITING: 'Patients waiting', IDLE: 'Idle' } as const;
const STATUS_TONE = { SERVING: 'bg-emerald-50 text-emerald-800', WAITING: 'bg-amber-50 text-amber-800', IDLE: 'bg-slate-100 text-slate-600' } as const;

/**
 * A read-only look at today's queues, doctor by doctor: the token being served and how many are waiting, finished and skipped. It
 * has no buttons that change anything, and it never receives patient names (the server does not send them to administrators).
 */
function Queues({ session }: { session: Session }) {
  const queue = useQueuePolling<AdminQueueBoard>(`queue-admin:${session.user.id}`, () => queueApi.admin(session), 15_000);
  const board = queue.data;
  const totals = board ? adminTotals(board) : null;

  return (
    <div className="animate-in fade-in-0 space-y-6 duration-300">
      <PageHeader title="Queues" description={board ? `Every doctor's queue for ${formatDate(board.date, { weekday: 'long' })}. Read only.` : "Every doctor's queue for today. Read only."} />

      {queue.loading && <Spinner label="Loading the queues…" />}
      {!board && !queue.loading && (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={() => void queue.refresh()}>
              Try again
            </Button>
          }
        >
          Could not load the queues. {queue.error}
        </Alert>
      )}

      {board && totals && (
        <>
          <Freshness updatedAt={queue.updatedAt} stale={queue.stale} error={queue.error} onRetry={() => void queue.refresh()} />
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Waiting" value={totals.waiting} />
            <Stat label="Being seen" value={totals.serving} />
            <Stat label="Completed" value={totals.completed + totals.checkedOut} />
            <Stat label="Skipped" value={totals.skipped} />
          </dl>
          {board.doctors.length === 0 ? (
            <EmptyState title="No queues yet today" icon={ListOrderedIcon}>
              A doctor&apos;s queue appears here once the front desk has checked in their first patient.
            </EmptyState>
          ) : (
            <div className="rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Doctor</TableHead>
                    <TableHead>Clinic</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Now serving</TableHead>
                    <TableHead className="text-center">Waiting</TableHead>
                    <TableHead className="text-center">Completed</TableHead>
                    <TableHead className="text-center">Skipped</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {board.doctors.map((row) => (
                    <TableRow key={row.doctor.id}>
                      <TableCell className="font-medium">{row.doctor.name}</TableCell>
                      <TableCell className="text-muted-foreground">{row.clinic}</TableCell>
                      <TableCell>
                        <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold', STATUS_TONE[row.status])}>{STATUS_TEXT[row.status]}</span>
                      </TableCell>
                      <TableCell className="text-center">{row.currentlyServingToken === null ? '–' : <TokenBadge token={row.currentlyServingToken} className="bg-emerald-700" />}</TableCell>
                      <TableCell className="text-center tabular-nums">{row.counts.waiting}</TableCell>
                      <TableCell className="text-center tabular-nums">{row.counts.completed + row.counts.checkedOut}</TableCell>
                      <TableCell className="text-center tabular-nums">{row.counts.skipped}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-3xl font-bold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
