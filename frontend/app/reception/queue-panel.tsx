'use client';

import { ArchiveIcon, CheckIcon, EyeIcon, LogInIcon, LogOutIcon, RotateCcwIcon, SkipForwardIcon, UserXIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, EmptyState } from '@/components/common';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { clinicClock, clinicToday, formatTimeRange, timeAgo } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { queueApi } from '@/lib/queue-client';
import {
  ARRIVAL_GRACE_MINUTES,
  actionNotice,
  arrivalPhase,
  buildDesk,
  canReopenLateCheckIn,
  entryActions,
  receptionCheckInDetail,
  wasLateCheckIn,
  type ArrivalRow,
  type DeskDoctor,
  type QueueAction,
} from '@/lib/queue-view';
import type { QueueEntryResult, QueueEntryView, ReceptionAppointment, ReceptionBoard, ReceptionDoctor, Session } from '@/lib/types';
import { useQueuePolling } from '../queue/use-queue-polling';
import { Freshness, QueueStatusPill, TokenBadge } from '../queue/queue-ui';

interface Desk {
  board: ReceptionBoard;
  appointments: ReceptionAppointment[];
}

const selectClass =
  'h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const archiveKey = (userId: string) => `reception-queue-hidden:${userId}`;

function readHidden(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(archiveKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeHidden(userId: string, ids: Set<string>) {
  localStorage.setItem(archiveKey(userId), JSON.stringify([...ids]));
}

/**
 * The front desk's queue: for each doctor who assigned this receptionist, who is being seen, who is waiting, who has finished or been
 * skipped, and who is still to arrive. Tokens are issued at booking; check-in / late arrival reuse them. Skip, manual no-show (after
 * the arrival grace), complete and check-out live here. Date, doctor and slot filters narrow what is shown; polling keeps the board current.
 */
export function QueuePanel({ session, doctors = [], refreshKey = 0 }: { session: Session; doctors?: ReceptionDoctor[]; refreshKey?: number }) {
  const [date, setDate] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [slotTime, setSlotTime] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
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
  const [confirmNoShow, setConfirmNoShow] = useState<{ appointmentId: string; name: string; token: number | null } | null>(null);
  const [confirmReopen, setConfirmReopen] = useState<{ appointmentId: string; name: string; token: number } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    setHiddenIds(readHidden(session.user.id));
  }, [session.user.id]);

  const hideFromDashboard = (appointmentId: string, entry: QueueEntryView) => {
    setHiddenIds((current) => {
      const next = new Set(current).add(appointmentId);
      writeHidden(session.user.id, next);
      return next;
    });
    setNotice({
      tone: 'success',
      text: `Hidden ${entry.patient.name} (token ${entry.token}) from the dashboard. History is unchanged.`,
    });
  };

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
        Tokens are issued when the appointment is booked. <span className="font-medium text-foreground">Check in</span> (or{' '}
        <span className="font-medium text-foreground">Late arrival</span> after the start — including 30+ minutes late) reuses that
        token and adds them at the <span className="font-medium text-foreground">end</span> of the waiting list. After the{' '}
        {ARRIVAL_GRACE_MINUTES}-minute grace you may also mark <span className="font-medium text-foreground">No show</span>{' '}
        (never automatic). Use <span className="font-medium text-foreground">Skip</span> for someone already in the queue who is not
        available; Return keeps the same token at the end of the line. After the consultation,{' '}
        <span className="font-medium text-foreground">Check out</span>. Checked-out and no-show history can be hidden here without
        deleting records.
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
        <Button type="button" variant="outline" className="h-10" onClick={() => setShowArchived((value) => !value)}>
          {showArchived ? <EyeIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
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
        <DoctorDesk
          key={doctor.doctor.id}
          entry={doctor}
          busy={busy}
          act={act}
          session={session}
          showArchived={showArchived}
          hiddenIds={hiddenIds}
          onHide={hideFromDashboard}
          onRequestNoShow={(item) => {
            setConfirmError(null);
            setConfirmNoShow({ appointmentId: item.appointmentId, name: item.patientName, token: item.token });
          }}
          onRequestReopen={(item) => {
            setConfirmError(null);
            setConfirmReopen({ appointmentId: item.appointmentId, name: item.patient.name, token: item.token });
          }}
        />
      ))}

      <ConfirmDialog
        open={confirmNoShow !== null}
        title="Mark this patient as no show?"
        description={
          confirmNoShow &&
          `${confirmNoShow.name}${confirmNoShow.token != null ? ` · token ${confirmNoShow.token}` : ''}. They leave the active queue; the appointment and token stay in history.`
        }
        confirmLabel="Mark no show"
        cancelLabel="Keep appointment"
        busy={busy !== null}
        error={confirmError}
        onClose={() => {
          if (busy) return;
          setConfirmNoShow(null);
          setConfirmError(null);
        }}
        onConfirm={() => {
          if (!confirmNoShow) return;
          void (async () => {
            setBusy(confirmNoShow.appointmentId);
            setConfirmError(null);
            try {
              const result = await queueApi.markNoShow(session, confirmNoShow.appointmentId);
              setNotice({ tone: 'success', text: actionNotice('noShow', result) });
              setConfirmNoShow(null);
              await desk.refresh();
            } catch (error) {
              setConfirmError(errorMessage(error));
            } finally {
              setBusy(null);
            }
          })();
        }}
      />

      <ConfirmDialog
        open={confirmReopen !== null}
        title="Reopen and late check-in?"
        description={
          confirmReopen &&
          `${confirmReopen.name} · token ${confirmReopen.token}. Restores the same appointment and token to the waiting queue.`
        }
        confirmLabel="Reopen & late check-in"
        cancelLabel="Cancel"
        busy={busy !== null}
        error={confirmError}
        onClose={() => {
          if (busy) return;
          setConfirmReopen(null);
          setConfirmError(null);
        }}
        onConfirm={() => {
          if (!confirmReopen) return;
          void (async () => {
            setBusy(confirmReopen.appointmentId);
            setConfirmError(null);
            try {
              const result = await queueApi.reopenLateCheckIn(session, confirmReopen.appointmentId);
              setNotice({ tone: 'success', text: actionNotice('reopenLateCheckIn', result) });
              setConfirmReopen(null);
              await desk.refresh();
            } catch (error) {
              setConfirmError(errorMessage(error));
            } finally {
              setBusy(null);
            }
          })();
        }}
      />
    </div>
  );
}

function DoctorDesk({
  entry,
  busy,
  act,
  session,
  showArchived,
  hiddenIds,
  onHide,
  onRequestNoShow,
  onRequestReopen,
}: {
  entry: DeskDoctor;
  busy: string | null;
  act: (key: string, action: QueueAction, run: () => Promise<QueueEntryResult>) => Promise<void>;
  session: Session;
  showArchived: boolean;
  hiddenIds: Set<string>;
  onHide: (appointmentId: string, entry: QueueEntryView) => void;
  onRequestNoShow: (item: ArrivalRow) => void;
  onRequestReopen: (item: QueueEntryView) => void;
}) {
  const { doctor, day, arrivals, awaitingPayment } = entry;
  const now = useNow(10_000);
  const run = (action: QueueAction, id: string) => {
    if (action === 'complete') return () => queueApi.completeAtDesk(session, id);
    if (action === 'skip') return () => queueApi.skipAtDesk(session, id);
    if (action === 'return') return () => queueApi.returnToQueue(session, id);
    return () => queueApi.checkOut(session, id);
  };
  const visible = (appointmentId: string) => showArchived || !hiddenIds.has(appointmentId);
  const checkedOut = day.checkedOut.filter((item) => visible(item.appointmentId));
  const cancelled = day.cancelled.filter((item) => visible(item.appointmentId));
  const archivedCount =
    day.checkedOut.filter((item) => hiddenIds.has(item.appointmentId)).length +
    day.cancelled.filter((item) => hiddenIds.has(item.appointmentId)).length;

  const row = (item: QueueEntryView, detail?: string, opts?: { archiveable?: boolean }) => {
    const late =
      item.checkedInAt != null &&
      wasLateCheckIn({ appointmentDate: day.date, startTime: item.appointment.startTime, checkedInAt: item.checkedInAt });
    return (
      <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <TokenBadge token={item.token} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            {item.patient.name}
            {late && (
              <Badge variant="secondary" className="bg-amber-50 font-semibold text-amber-900">
                Late arrival
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Appointment {formatTimeRange(item.appointment.startTime, item.appointment.endTime, true)}
            {' · '}
            {receptionCheckInDetail(item, {
              appointmentDate: day.date,
              phone: item.patient.phone,
              nowMs: now,
              extra: detail,
            })}
          </p>
        </div>
        <QueueStatusPill status={item.status} />
        {entryActions('RECEPTIONIST', item.status).map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === 'checkOut' || action === 'complete' ? 'default' : 'outline'}
            disabled={busy !== null}
            aria-label={`${ACTION_LABEL[action]}: token ${item.token}, ${item.patient.name}`}
            onClick={() => void act(item.id, action, run(action, item.id))}
          >
            {ACTION_ICON[action]} {busy === item.id ? 'Working…' : ACTION_LABEL[action]}
          </Button>
        ))}
        {opts?.archiveable && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            aria-label={`Hide ${item.patient.name} from dashboard`}
            onClick={() => onHide(item.appointmentId, item)}
          >
            <ArchiveIcon aria-hidden /> Hide
          </Button>
        )}
      </li>
    );
  };

  const clock = clinicClock(now);
  const arrival = (item: ArrivalRow, canCheckIn: boolean) => {
    const phase = arrivalPhase({ appointmentDate: day.date, startTime: item.startTime, nowDate: clock.date, nowTime: clock.time });
    const late = phase === 'late' || phase === 'no_show_eligible';
    const checkAction: QueueAction = late ? 'lateArrival' : 'checkIn';
    return (
      <li key={item.appointmentId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        {item.token != null ? <TokenBadge token={item.token} /> : <span className="w-10 text-center text-xs text-muted-foreground">–</span>}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            {item.patientName}
            {canCheckIn && late && (
              <Badge variant="secondary" className="bg-amber-50 font-semibold text-amber-900">
                {phase === 'no_show_eligible' ? 'Past grace' : 'Late'}
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Appointment {formatTimeRange(item.startTime, item.endTime, true)}
            {item.phone ? ` · ${item.phone}` : ''}
            {item.token != null ? ` · token ${item.token}` : ''}
          </p>
        </div>
        {canCheckIn ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              aria-label={`${late ? 'Late arrival' : 'Check in'} ${item.patientName}`}
              onClick={() => void act(item.appointmentId, checkAction, () => queueApi.checkIn(session, item.appointmentId))}
            >
              <LogInIcon aria-hidden /> {busy === item.appointmentId ? 'Checking in…' : late ? 'Late arrival' : 'Check in'}
            </Button>
            {phase === 'no_show_eligible' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                aria-label={`Mark no show for ${item.patientName}`}
                onClick={() => onRequestNoShow(item)}
              >
                <UserXIcon aria-hidden /> No show
              </Button>
            )}
          </div>
        ) : (
          <span className="text-xs font-medium text-amber-700">Awaiting payment</span>
        )}
      </li>
    );
  };

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
          {!showArchived && archivedCount > 0 && <span className="text-muted-foreground">{archivedCount} archived</span>}
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
      {day.skipped.length > 0 && (
        <Group title={`Skipped (${day.skipped.length})`}>
          {day.skipped.map((item) => {
            const phase = arrivalPhase({ appointmentDate: day.date, startTime: item.appointment.startTime, nowDate: clock.date, nowTime: clock.time });
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
                <TokenBadge token={item.token} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{item.patient.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatTimeRange(item.appointment.startTime, item.appointment.endTime, true)}
                    {item.patient.phone ? ` · ${item.patient.phone}` : ''}
                  </p>
                </div>
                <QueueStatusPill status={item.status} />
                {entryActions('RECEPTIONIST', item.status).map((action) => (
                  <Button key={action} size="sm" variant="outline" disabled={busy !== null} aria-label={`${ACTION_LABEL[action]}: token ${item.token}, ${item.patient.name}`} onClick={() => void act(item.id, action, run(action, item.id))}>
                    {ACTION_ICON[action]} {busy === item.id ? 'Working…' : ACTION_LABEL[action]}
                  </Button>
                ))}
                {phase === 'no_show_eligible' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    aria-label={`Mark no show for ${item.patient.name}`}
                    onClick={() =>
                      onRequestNoShow({
                        appointmentId: item.appointmentId,
                        patientName: item.patient.name,
                        phone: item.patient.phone ?? null,
                        startTime: item.appointment.startTime,
                        endTime: item.appointment.endTime,
                        token: item.token,
                      })
                    }
                  >
                    <UserXIcon aria-hidden /> No show
                  </Button>
                )}
              </li>
            );
          })}
        </Group>
      )}
      {checkedOut.length > 0 && (
        <Group title={`Checked out (${checkedOut.length})`}>{checkedOut.map((item) => row(item, undefined, { archiveable: true }))}</Group>
      )}
      {cancelled.length > 0 && (
        <Group title={`No show / cancelled (${cancelled.length})`}>
          {cancelled.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
              <TokenBadge token={item.token} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">{item.patient.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatTimeRange(item.appointment.startTime, item.appointment.endTime, true)}
                  {item.appointmentStatus === 'NO_SHOW' ? ' · no show' : ' · cancelled'}
                  {' · token kept'}
                </p>
              </div>
              <QueueStatusPill status={item.status} />
              {canReopenLateCheckIn(item) && (
                <Button size="sm" disabled={busy !== null} aria-label={`Reopen and late check-in ${item.patient.name}`} onClick={() => onRequestReopen(item)}>
                  <LogInIcon aria-hidden /> Reopen & late check-in
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy !== null} aria-label={`Hide ${item.patient.name} from dashboard`} onClick={() => onHide(item.appointmentId, item)}>
                <ArchiveIcon aria-hidden /> Hide
              </Button>
            </li>
          ))}
        </Group>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<QueueAction, string> = {
  checkIn: 'Check in',
  lateArrival: 'Late arrival',
  checkOut: 'Check out',
  skip: 'Skip',
  return: 'Return to queue',
  complete: 'Complete',
  noShow: 'No show',
  reopenLateCheckIn: 'Reopen & late check-in',
  archive: 'Hide',
};
const ACTION_ICON: Partial<Record<QueueAction, React.ReactNode>> = {
  complete: <CheckIcon aria-hidden />,
  checkOut: <LogOutIcon aria-hidden />,
  skip: <SkipForwardIcon aria-hidden />,
  return: <RotateCcwIcon aria-hidden />,
  noShow: <UserXIcon aria-hidden />,
  lateArrival: <LogInIcon aria-hidden />,
  reopenLateCheckIn: <LogInIcon aria-hidden />,
  archive: <ArchiveIcon aria-hidden />,
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
