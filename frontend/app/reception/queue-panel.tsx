'use client';

import { CheckIcon, LogInIcon, LogOutIcon, RotateCcwIcon, SkipForwardIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, EmptyState } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { clinicToday, formatTimeRange, timeAgo } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { queueApi } from '@/lib/queue-client';
import { actionNotice, buildDesk, entryActions, type ArrivalRow, type DeskDoctor, type QueueAction } from '@/lib/queue-view';
import type { QueueEntryResult, QueueEntryView, ReceptionAppointment, ReceptionBoard, ReceptionDoctor, Session } from '@/lib/types';
import { useQueuePolling } from '../queue/use-queue-polling';
import { Freshness, QueueStatusPill, TokenBadge } from '../queue/queue-ui';

interface Desk {
  board: ReceptionBoard;
  appointments: ReceptionAppointment[];
}

const selectClass =
  'h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * The front desk's queue: for each doctor who assigned this receptionist, who is being seen, who is waiting, who has finished or been
 * skipped, and who is still to arrive. Checking in reuses the booking-time token. Completing and checking out are available here.
 * Date, doctor and slot filters narrow what is shown; polling keeps the board current.
 */
export function QueuePanel({ session, doctors = [], refreshKey = 0 }: { session: Session; doctors?: ReceptionDoctor[]; refreshKey?: number }) {
  const [date, setDate] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [slotTime, setSlotTime] = useState('');
  const boardDate = date || undefined;
  const desk = useQueuePolling<Desk>(
    `queue-desk:${session.user.id}:${refreshKey}:${boardDate ?? 'today'}:${doctorId || 'all'}`,
    async () => {
      const board = await queueApi.board(session, { date: boardDate, doctorId: doctorId || undefined });
      const appointments = await api<ReceptionAppointment[]>(
        `/receptionist/appointments?date=${board.date}${doctorId ? `&doctorId=${doctorId}` : ''}`,
        { token: session.accessToken },
      );
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

  const slotOptions = useMemo(() => {
    if (!desk.data) return [] as string[];
    const times = new Set<string>();
    for (const day of desk.data.board.doctors) {
      for (const entry of [...(day.booked ?? []), ...day.waiting, ...(day.serving ? [day.serving] : []), ...day.completed, ...day.checkedOut, ...day.skipped]) {
        times.add(entry.appointment.startTime);
      }
    }
    for (const appointment of desk.data.appointments) times.add(appointment.startTime);
    return [...times].sort();
  }, [desk.data]);

  if (desk.loading && !desk.data) {
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

  const matchesSlot = (startTime: string) => !slotTime || startTime === slotTime;
  const filtered = buildDesk(desk.data.board, desk.data.appointments).map((entry) => {
    if (!slotTime) return entry;
    const serving = entry.day.serving && matchesSlot(entry.day.serving.appointment.startTime) ? entry.day.serving : null;
    return {
      ...entry,
      arrivals: entry.arrivals.filter((row) => matchesSlot(row.startTime)),
      awaitingPayment: entry.awaitingPayment.filter((row) => matchesSlot(row.startTime)),
      day: {
        ...entry.day,
        serving,
        currentlyServingToken: serving?.token ?? null,
        booked: (entry.day.booked ?? []).filter((row) => matchesSlot(row.appointment.startTime)),
        waiting: entry.day.waiting.filter((row) => matchesSlot(row.appointment.startTime)),
        completed: entry.day.completed.filter((row) => matchesSlot(row.appointment.startTime)),
        checkedOut: entry.day.checkedOut.filter((row) => matchesSlot(row.appointment.startTime)),
        skipped: entry.day.skipped.filter((row) => matchesSlot(row.appointment.startTime)),
        cancelled: entry.day.cancelled.filter((row) => matchesSlot(row.appointment.startTime)),
      },
    };
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tokens are issued when the appointment is booked. <span className="font-medium text-foreground">Check in</span> reuses that token.
        After the consultation, mark the patient <span className="font-medium text-foreground">Completed</span>, then check them out.
      </p>
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <div className="space-y-2">
          <Label htmlFor="queue-date">Date</Label>
          <Input
            id="queue-date"
            type="date"
            value={date || clinicToday() || ''}
            onChange={(event) => setDate(event.target.value === clinicToday() ? '' : event.target.value)}
            className="h-10 w-44 bg-background"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="queue-doctor">Doctor</Label>
          <select id="queue-doctor" value={doctorId} onChange={(event) => setDoctorId(event.target.value)} className={selectClass}>
            <option value="">All assigned doctors</option>
            {doctors.map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                {doctor.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="queue-slot">Appointment slot</Label>
          <select id="queue-slot" value={slotTime} onChange={(event) => setSlotTime(event.target.value)} className={selectClass}>
            <option value="">All slots</option>
            {slotOptions.map((time) => (
              <option key={time} value={time}>
                {formatTimeRange(time, time, true).split('–')[0]?.trim() || time}
              </option>
            ))}
          </select>
        </div>
        {(date || doctorId || slotTime) && (
          <Button
            type="button"
            variant="outline"
            className="h-10"
            onClick={() => {
              setDate('');
              setDoctorId('');
              setSlotTime('');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Freshness updatedAt={desk.updatedAt} stale={desk.stale} error={desk.error} onRetry={() => void desk.refresh()} />
      {filtered.length === 0 && (
        <EmptyState title="No assigned doctors">
          There is no queue to show until a doctor assigns you as their receptionist.
        </EmptyState>
      )}
      {filtered.map((doctor) => (
        <DoctorDesk key={doctor.doctor.id} entry={doctor} busy={busy} act={act} session={session} />
      ))}
    </div>
  );
}

function DoctorDesk({ entry, busy, act, session }: { entry: DeskDoctor; busy: string | null; act: (key: string, action: QueueAction, run: () => Promise<QueueEntryResult>) => Promise<void>; session: Session }) {
  const { doctor, day, arrivals, awaitingPayment } = entry;
  const now = useNow(15_000);
  const run = (action: QueueAction, id: string) => {
    if (action === 'complete') return () => queueApi.completeAtDesk(session, id);
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
          {formatTimeRange(item.appointment.startTime, item.appointment.endTime, true)}
          {item.patient.phone ? ` · ${item.patient.phone}` : ''}
          {' · '}
          {detail ?? (item.checkedInAt ? `checked in ${timeAgo(item.checkedInAt, now)}` : 'not checked in yet')}
        </p>
      </div>
      <QueueStatusPill status={item.status} />
      {entryActions('RECEPTIONIST', item.status).map((action) => (
        <Button key={action} size="sm" variant={action === 'checkOut' || action === 'complete' ? 'default' : 'outline'} disabled={busy !== null} aria-label={`${ACTION_LABEL[action]}: token ${item.token}, ${item.patient.name}`} onClick={() => void act(item.id, action, run(action, item.id))}>
          {ACTION_ICON[action]} {busy === item.id ? 'Working…' : ACTION_LABEL[action]}
        </Button>
      ))}
    </li>
  );

  const arrival = (item: ArrivalRow, canCheckIn: boolean) => (
    <li key={item.appointmentId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      {item.token != null ? <TokenBadge token={item.token} /> : <span className="w-10 text-center text-xs text-muted-foreground">–</span>}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{item.patientName}</p>
        <p className="text-xs text-muted-foreground">
          Appointment {formatTimeRange(item.startTime, item.endTime, true)}
          {item.phone ? ` · ${item.phone}` : ''}
          {item.token != null ? ` · token ${item.token}` : ''}
        </p>
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
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            Now serving {day.currentlyServingToken === null ? <span className="font-semibold text-muted-foreground">–</span> : <TokenBadge token={day.currentlyServingToken} className="bg-emerald-700" />}
          </span>
          <span className="text-muted-foreground">{day.counts.waiting} waiting</span>
          <span className="text-muted-foreground">{day.counts.completed + day.counts.checkedOut} done</span>
        </div>
      </div>

      {day.serving && <Group title="Being seen">{row(day.serving, day.serving.calledAt ? `called ${timeAgo(day.serving.calledAt, now)}` : undefined)}</Group>}
      <Group title={`Waiting (${day.waiting.length})`} empty="Nobody is waiting.">
        {day.waiting.map((item) => row(item))}
      </Group>
      <Group title={`Arriving today (${arrivals.length + awaitingPayment.length})`} empty="Everyone with a confirmed appointment today has been checked in.">
        {arrivals.map((item) => arrival(item, true))}
        {awaitingPayment.map((item) => arrival(item, false))}
      </Group>
      {day.completed.length > 0 && <Group title={`Completed — check out (${day.completed.length})`}>{day.completed.map((item) => row(item))}</Group>}
      {day.checkedOut.length > 0 && <Group title={`Checked out (${day.checkedOut.length})`}>{day.checkedOut.map((item) => row(item))}</Group>}
      {day.skipped.length > 0 && <Group title={`Skipped (${day.skipped.length})`}>{day.skipped.map((item) => row(item))}</Group>}
      {day.cancelled.length > 0 && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">{day.cancelled.length} cancelled (token kept, not reused)</p>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<QueueAction, string> = { checkIn: 'Check in', checkOut: 'Check out', skip: 'Skip', return: 'Return to queue', complete: 'Complete' };
const ACTION_ICON: Partial<Record<QueueAction, React.ReactNode>> = {
  complete: <CheckIcon aria-hidden />,
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
