'use client';

import { LogInIcon, LogOutIcon, RotateCcwIcon, SkipForwardIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { formatTimeRange, timeAgo } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { queueApi } from '@/lib/queue-client';
import { actionNotice, buildDesk, entryActions, type ArrivalRow, type DeskDoctor, type QueueAction } from '@/lib/queue-view';
import type { QueueEntryResult, QueueEntryView, ReceptionAppointment, ReceptionBoard, Session } from '@/lib/types';
import { useQueuePolling } from '../queue/use-queue-polling';
import { Freshness, QueueStatusPill, TokenBadge } from '../queue/queue-ui';

interface Desk {
  board: ReceptionBoard;
  appointments: ReceptionAppointment[];
}

/**
 * The front desk's queue: for each doctor who assigned this receptionist, who is being seen, who is waiting, who has finished or been
 * skipped, and who is still to arrive today. Checking in, skipping, returning and checking out are buttons here; each one asks the
 * server, which applies the rules (confirmed appointments on their own day only, checkout only after completion, assigned doctors only)
 * and whose answer is shown, including a refusal. Keeps itself up to date by polling.
 */
export function QueuePanel({ session, refreshKey = 0 }: { session: Session; refreshKey?: number }) {
  const desk = useQueuePolling<Desk>(
    `queue-desk:${session.user.id}:${refreshKey}`,
    async () => {
      // Board date comes from the server's clinic calendar; load today's appointments for that same day so arrivals and check-in stay aligned.
      const board = await queueApi.board(session);
      const appointments = await api<ReceptionAppointment[]>(`/receptionist/appointments?date=${board.date}`, { token: session.accessToken });
      return { board, appointments };
    },
    10_000,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const act = async (key: string, action: QueueAction, run: () => Promise<QueueEntryResult>) => {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    try {
      setNotice({ tone: 'success', text: actionNotice(action, await run()) });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
      await desk.refresh();
    }
  };

  if (desk.loading) {
    return (
      <div aria-busy="true" className="space-y-3 rounded-xl border bg-card p-5">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (!desk.data) {
    const migrationHint = desk.error?.includes('migration 015') || desk.error?.includes('not been updated');
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={() => void desk.refresh()}>
            Try again
          </Button>
        }
      >
        {migrationHint
          ? `Queue check-in is unavailable until the database has migration 015. ${desk.error}`
          : `Could not load the queue. ${desk.error}`}
      </Alert>
    );
  }

  const doctors = buildDesk(desk.data.board, desk.data.appointments);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Today&apos;s confirmed arrivals show a <span className="font-medium text-foreground">Check in</span> button. That issues the next token for that doctor, emails the patient, and adds them to the waiting list.
      </p>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Freshness updatedAt={desk.updatedAt} stale={desk.stale} error={desk.error} onRetry={() => void desk.refresh()} />
      {doctors.length === 0 && (
        <EmptyState title="No assigned doctors">
          There is no queue to show until a doctor assigns you as their receptionist.
        </EmptyState>
      )}
      {doctors.map((doctor) => (
        <DoctorDesk key={doctor.doctor.id} entry={doctor} busy={busy} act={act} session={session} />
      ))}
    </div>
  );
}

function DoctorDesk({ entry, busy, act, session }: { entry: DeskDoctor; busy: string | null; act: (key: string, action: QueueAction, run: () => Promise<QueueEntryResult>) => Promise<void>; session: Session }) {
  const { doctor, day, arrivals, awaitingPayment } = entry;
  const now = useNow(15_000);
  const run = (action: QueueAction, id: string) => {
    if (action === 'skip') return () => queueApi.skipAtDesk(session, id);
    if (action === 'return') return () => queueApi.returnToQueue(session, id);
    return () => queueApi.checkOut(session, id);
  };
  const row = (item: QueueEntryView, detail?: string) => (
    <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <TokenBadge token={item.token} />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{item.patient.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatTimeRange(item.appointment.startTime, item.appointment.endTime, true)} · {detail ?? `checked in ${timeAgo(item.checkedInAt, now)}`}
        </p>
      </div>
      <QueueStatusPill status={item.status} />
      {entryActions('RECEPTIONIST', item.status).map((action) => (
        <Button key={action} size="sm" variant={action === 'checkOut' ? 'default' : 'outline'} disabled={busy !== null} aria-label={`${ACTION_LABEL[action]}: token ${item.token}, ${item.patient.name}`} onClick={() => void act(item.id, action, run(action, item.id))}>
          {ACTION_ICON[action]} {busy === item.id ? 'Working…' : ACTION_LABEL[action]}
        </Button>
      ))}
    </li>
  );

  const arrival = (item: ArrivalRow, canCheckIn: boolean) => (
    <li key={item.appointmentId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{item.patientName}</p>
        <p className="text-xs text-muted-foreground">Appointment {formatTimeRange(item.startTime, item.endTime, true)}</p>
      </div>
      {canCheckIn ? (
        <Button size="sm" disabled={busy !== null} aria-label={`Check in ${item.patientName}`} onClick={() => void act(item.appointmentId, 'checkIn', () => queueApi.checkIn(session, item.appointmentId))}>
          <LogInIcon aria-hidden /> {busy === item.appointmentId ? 'Checking in…' : 'Check in'}
        </Button>
      ) : (
        <span className="text-xs font-medium text-amber-700">Awaiting payment</span>
      )}
    </li>
  );

  return (
    <section aria-label={`Queue for ${doctor.name}`} className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="font-semibold text-foreground">{doctor.name}</h3>
          <p className="text-xs text-muted-foreground">{doctor.clinic}</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            Now serving {day.currentlyServingToken === null ? <span className="font-semibold text-muted-foreground">–</span> : <TokenBadge token={day.currentlyServingToken} className="bg-emerald-700" />}
          </span>
          <span className="text-muted-foreground">{day.counts.waiting} waiting</span>
        </div>
      </div>

      {day.serving && <Group title="Being seen">{row(day.serving, day.serving.calledAt ? `called ${timeAgo(day.serving.calledAt, now)}` : undefined)}</Group>}
      <Group title={`Waiting (${day.waiting.length})`} empty="Nobody is waiting.">
        {day.waiting.map((item) => row(item))}
      </Group>
      <Group title={`Arriving today (${arrivals.length})`} empty="Everyone with a confirmed appointment today has been checked in.">
        {arrivals.map((item) => arrival(item, true))}
        {awaitingPayment.map((item) => arrival(item, false))}
      </Group>
      {day.completed.length > 0 && <Group title={`Consultation finished: check out (${day.completed.length})`}>{day.completed.map((item) => row(item))}</Group>}
      {day.skipped.length > 0 && <Group title={`Skipped (${day.skipped.length})`}>{day.skipped.map((item) => row(item))}</Group>}
      {(day.checkedOut.length > 0 || day.cancelled.length > 0) && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          {day.checkedOut.length} checked out{day.cancelled.length > 0 ? ` · ${day.cancelled.length} cancelled` : ''}
        </p>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<QueueAction, string> = { checkIn: 'Check in', checkOut: 'Check out', skip: 'Skip', return: 'Return to queue', complete: 'Complete' };
const ACTION_ICON: Partial<Record<QueueAction, React.ReactNode>> = {
  checkOut: <LogOutIcon aria-hidden />,
  skip: <SkipForwardIcon aria-hidden />,
  return: <RotateCcwIcon aria-hidden />,
};

function Group({ title, empty, children }: { title: string; empty?: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children ? [children] : [];
  return (
    <div className="border-b last:border-b-0">
      <h4 className="bg-muted/40 px-4 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      {items.length === 0 ? empty ? <p className="px-4 py-2.5 text-sm text-muted-foreground">{empty}</p> : null : <ul className="divide-y">{children}</ul>}
    </div>
  );
}
