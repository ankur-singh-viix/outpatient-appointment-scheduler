import { clinicClock, formatClockTime, waitingDuration } from './format';
import type { AdminQueueBoard, MyQueueEntry, QueueCounts, QueueDay, QueueEntryResult, QueueEntryView, QueueStatus, ReceptionAppointment, ReceptionBoard } from './types';

/**
 * What the queue screens say and offer, as plain functions so it is tested without a browser. None of it decides anything about the
 * queue itself: the order, the positions and the rules (who may check in or be called) are the server's. These only choose the words
 * for a patient, group what the server returned for the front desk, and say which buttons make sense for a status; the server still
 * refuses anything that is not allowed.
 */

/** A patient with this many people ahead (or fewer) is told their turn is approaching. */
export const APPROACHING_AT = 2;

/** Minutes after the booked start before the desk may mark a no-show (matches backend ARRIVAL_GRACE_MINUTES). */
export const ARRIVAL_GRACE_MINUTES = 15;

export type ArrivalPhase = 'on_time' | 'late' | 'no_show_eligible';

/** Minutes from HH:MM `from` to HH:MM `to` on the same day. */
export function minutesBetween(from: string, to: string): number {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return th * 60 + tm - (fh * 60 + fm);
}

/**
 * Where the clinic clock sits relative to the appointment start and the grace window.
 * Late arrival still uses check-in; no-show is only offered once grace has elapsed.
 */
export function arrivalPhase(input: {
  appointmentDate: string;
  startTime: string;
  nowDate: string;
  nowTime: string;
  graceMinutes?: number;
}): ArrivalPhase {
  const grace = input.graceMinutes ?? ARRIVAL_GRACE_MINUTES;
  if (input.appointmentDate > input.nowDate) return 'on_time';
  if (input.appointmentDate < input.nowDate) return 'no_show_eligible';
  const elapsed = minutesBetween(input.startTime, input.nowTime);
  if (elapsed < 0) return 'on_time';
  if (elapsed < grace) return 'late';
  return 'no_show_eligible';
}

/** True when the server check-in instant is at or after the booked start (clinic zone). */
export function wasLateCheckIn(input: { appointmentDate: string; startTime: string; checkedInAt: string }): boolean {
  const at = clinicClock(Date.parse(input.checkedInAt));
  if (at.date > input.appointmentDate) return true;
  if (at.date < input.appointmentDate) return false;
  return minutesBetween(input.startTime, at.time) >= 0;
}

/**
 * Doctor queue detail line: actual check-in clock time and live waiting duration — never the original appointment slot.
 * Null when the patient has not checked in yet.
 */
export function doctorCheckInDetail(entry: Pick<QueueEntryView, 'checkedInAt'>, nowMs: number): string | null {
  if (!entry.checkedInAt) return null;
  return `Checked in ${formatClockTime(entry.checkedInAt)} · waiting ${waitingDuration(entry.checkedInAt, nowMs)}`;
}

/**
 * Reception queue detail for a checked-in patient: appointment slot, actual check-in time, late flag, and live waiting duration.
 */
export function receptionCheckInDetail(
  entry: Pick<QueueEntryView, 'checkedInAt' | 'appointment'>,
  opts: { appointmentDate: string; phone?: string | null; nowMs: number; extra?: string },
): string {
  const parts: string[] = [];
  if (opts.phone) parts.push(opts.phone);
  if (entry.checkedInAt) {
    parts.push(`checked in ${formatClockTime(entry.checkedInAt)}`);
    if (wasLateCheckIn({ appointmentDate: opts.appointmentDate, startTime: entry.appointment.startTime, checkedInAt: entry.checkedInAt })) {
      parts.push('late arrival');
    }
    parts.push(`waiting ${waitingDuration(entry.checkedInAt, opts.nowMs)}`);
  } else {
    parts.push('not checked in yet');
  }
  if (opts.extra) parts.push(opts.extra);
  return parts.join(' · ');
}

export const STATUS_LABEL: Record<QueueStatus, string> = {
  BOOKED: 'Booked',
  WAITING: 'Waiting',
  SERVING: 'Serving',
  COMPLETED: 'Completed',
  CHECKED_OUT: 'Checked out',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
};

/** "You are next", "1 patient ahead", "4 patients ahead", or a dash when there is no place in the line. */
export function aheadText(ahead: number | null): string {
  if (ahead === null) return '–';
  if (ahead === 0) return 'You are next';
  return `${ahead} patient${ahead === 1 ? '' : 's'} ahead`;
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th", … */
export function ordinal(n: number): string {
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * The patient's place in the live line from the server's `ahead` count (serving patients count as ahead).
 * Null when they are not in the active queue yet (e.g. BOOKED) or have left it.
 */
export function queuePositionLabel(entry: Pick<MyQueueEntry, 'status' | 'ahead'>): string | null {
  if (entry.status === 'SERVING') return 'Being seen now';
  if (entry.status !== 'WAITING' || entry.ahead === null) return null;
  if (entry.ahead === 0) return 'You are next';
  return `${ordinal(entry.ahead + 1)} in queue`;
}

export interface PatientMessage {
  headline: string;
  detail: string;
  tone: 'waiting' | 'soon' | 'now' | 'done' | 'attention';
}

/** What to tell a patient waiting at the clinic: short, calm, and about the next thing to do. */
export function patientMessage(entry: Pick<MyQueueEntry, 'status' | 'ahead' | 'currentlyServingToken'>): PatientMessage {
  switch (entry.status) {
    case 'WAITING': {
      const ahead = entry.ahead ?? 0;
      const place = ahead === 0 ? 'You are next' : `You are ${ordinal(ahead + 1)} in the queue`;
      if (ahead <= APPROACHING_AT) {
        return {
          tone: 'soon',
          headline: ahead === 0 ? 'You are next.' : 'Your turn is approaching.',
          detail: ahead === 0 ? 'Please stay close to the consultation room.' : `${place}: ${ahead} patient${ahead === 1 ? ' is' : 's are'} ahead of you. Please stay nearby.`,
        };
      }
      return {
        tone: 'waiting',
        headline: `${place}.`,
        detail: `${ahead} patients are ahead of you${entry.currentlyServingToken === null ? '' : `; token ${entry.currentlyServingToken} is being seen now`}. This page updates by itself.`,
      };
    }
    case 'BOOKED':
      return { tone: 'waiting', headline: 'Your appointment is booked.', detail: 'Check in at the front desk when you arrive. Your queue token is already reserved.' };
    case 'SERVING':
      return { tone: 'now', headline: 'Please proceed to the consultation room.', detail: 'Your consultation is in progress.' };
    case 'COMPLETED':
      return { tone: 'done', headline: 'Your consultation is completed.', detail: 'Please check out at the front desk.' };
    case 'CHECKED_OUT':
      return { tone: 'done', headline: 'You have checked out.', detail: 'Thank you for visiting.' };
    case 'SKIPPED':
      return { tone: 'attention', headline: 'You were skipped.', detail: 'You were not available when your token was called. Please see the front desk to rejoin the queue.' };
    case 'CANCELLED':
      return { tone: 'attention', headline: 'This appointment was cancelled.', detail: 'You are no longer in the queue.' };
  }
}

export type QueueAction = 'checkIn' | 'lateArrival' | 'checkOut' | 'skip' | 'return' | 'complete' | 'noShow';

/**
 * The buttons that make sense for a patient in a given status, by role. The receptionist skips someone who is not here, returns a
 * skipped patient and checks out a completed one; the doctor completes the consultation and may skip a patient who is unavailable
 * (waiting, or called but absent). The server decides what is really allowed; a button offered here can still be refused.
 */
export function entryActions(role: 'RECEPTIONIST' | 'DOCTOR', status: QueueStatus): QueueAction[] {
  if (role === 'RECEPTIONIST') {
    if (status === 'SERVING') return ['complete', 'skip'];
    if (status === 'WAITING') return ['skip'];
    if (status === 'COMPLETED') return ['checkOut'];
    if (status === 'SKIPPED') return ['return'];
    return [];
  }
  if (status === 'SERVING') return ['complete', 'skip'];
  if (status === 'WAITING') return ['skip'];
  return [];
}

/** The doctor can call the next patient when nobody is being served and somebody is waiting. */
export function canCallNext(day: Pick<QueueDay, 'serving' | 'waiting'>): boolean {
  return day.serving === null && day.waiting.length > 0;
}

/** How far through the day the queue is: patients seen (completed or checked out) of everyone who is, or was, in it. Cancelled ones are not counted. */
export function progress(counts: QueueCounts): { total: number; done: number; percent: number } {
  const done = counts.completed + counts.checkedOut;
  const total = counts.waiting + counts.serving + counts.completed + counts.checkedOut + counts.skipped;
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export interface ArrivalRow {
  appointmentId: string;
  patientName: string;
  phone: string | null;
  startTime: string;
  endTime: string;
  /** Token issued at booking; shown before check-in. */
  token: number | null;
}

export interface DeskDoctor {
  doctor: { id: string; name: string; clinic: string };
  day: QueueDay;
  /** Confirmed appointments today whose patients have not been checked in yet, in appointment order. */
  arrivals: ArrivalRow[];
  /** Today's bookings still waiting for payment: they cannot be checked in yet. */
  awaitingPayment: ArrivalRow[];
}

const everyEntry = (day: QueueDay): QueueEntryView[] => [
  ...(day.serving ? [day.serving] : []),
  ...(day.booked ?? []),
  ...day.waiting,
  ...day.completed,
  ...day.checkedOut,
  ...day.skipped,
  ...day.cancelled,
];

/**
 * The front desk's view: for each doctor, the live queue from the server and the appointments today that are still to arrive.
 * BOOKED queue entries (token already issued) are the primary arrivals list; any confirmed appointment without an entry is included
 * as a fallback. PENDING appointments never have a token yet.
 */
export function buildDesk(board: ReceptionBoard, appointments: ReceptionAppointment[]): DeskDoctor[] {
  const queued = new Set(board.doctors.flatMap((day) => everyEntry(day).map((entry) => entry.appointmentId)));
  return board.doctors.map((day) => {
    const { doctor } = day;
    const fromBooked: ArrivalRow[] = (day.booked ?? [])
      .slice()
      .sort((a, b) => a.appointment.startTime.localeCompare(b.appointment.startTime) || a.patient.name.localeCompare(b.patient.name))
      .map((entry) => ({
        appointmentId: entry.appointmentId,
        patientName: entry.patient.name,
        phone: entry.patient.phone ?? null,
        startTime: entry.appointment.startTime,
        endTime: entry.appointment.endTime,
        token: entry.token,
      }));
    const todays = appointments
      .filter((appointment) => appointment.doctor.id === doctor.id && appointment.date === board.date && !queued.has(appointment.id))
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.patient.name.localeCompare(b.patient.name))
      .map((appointment) => ({
        appointment,
        row: {
          appointmentId: appointment.id,
          patientName: appointment.patient.name,
          phone: appointment.patient.phone,
          startTime: appointment.startTime,
          endTime: appointment.endTime,
          token: appointment.queueToken,
        },
      }));
    return {
      doctor,
      day,
      arrivals: [...fromBooked, ...todays.filter(({ appointment }) => appointment.status === 'CONFIRMED').map(({ row }) => row)],
      awaitingPayment: todays.filter(({ appointment }) => appointment.status === 'PENDING').map(({ row }) => row),
    };
  });
}

/** The sentence shown after an action succeeds, from what the server answered. */
export function actionNotice(action: QueueAction | 'callNext', entry: QueueEntryResult): string {
  const who = entry.patient.name;
  switch (action) {
    case 'checkIn':
      return `Checked in ${who}: token ${entry.token}. ${aheadText(entry.ahead)}.`;
    case 'lateArrival':
      return `Late arrival: checked in ${who} with token ${entry.token}. ${aheadText(entry.ahead)}.`;
    case 'callNext':
      return `Called token ${entry.token}, ${who}.`;
    case 'complete':
      return `Completed the consultation for token ${entry.token}, ${who}.`;
    case 'checkOut':
      return `Checked out ${who} (token ${entry.token}).`;
    case 'skip':
      return `Skipped token ${entry.token}, ${who}.`;
    case 'return':
      return `Returned token ${entry.token}, ${who}, to the queue.`;
    case 'noShow':
      return `Marked ${who} (token ${entry.token}) as no show. Removed from the active queue; the appointment stays in history.`;
  }
}

/** The administrator's totals across every doctor, for the summary line. */
export function adminTotals(board: AdminQueueBoard): QueueCounts {
  const total: QueueCounts = { waiting: 0, serving: 0, completed: 0, checkedOut: 0, skipped: 0, cancelled: 0 };
  for (const { counts } of board.doctors) {
    for (const key of Object.keys(total) as (keyof QueueCounts)[]) {
      total[key] = (total[key] ?? 0) + (counts[key] ?? 0);
    }
  }
  return total;
}
