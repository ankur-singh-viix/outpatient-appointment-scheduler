import type { AdminQueueBoard, MyQueueEntry, QueueCounts, QueueDay, QueueEntryResult, QueueEntryView, QueueStatus, ReceptionAppointment, ReceptionBoard } from './types';

/**
 * What the queue screens say and offer, as plain functions so it is tested without a browser. None of it decides anything about the
 * queue itself: the order, the positions and the rules (who may check in or be called) are the server's. These only choose the words
 * for a patient, group what the server returned for the front desk, and say which buttons make sense for a status; the server still
 * refuses anything that is not allowed.
 */

/** A patient with this many people ahead (or fewer) is told their turn is approaching. */
export const APPROACHING_AT = 2;

export const STATUS_LABEL: Record<QueueStatus, string> = {
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
      if (ahead <= APPROACHING_AT) {
        return {
          tone: 'soon',
          headline: 'Your turn is approaching.',
          detail: ahead === 0 ? 'You are next. Please stay close to the consultation room.' : `${ahead} patient${ahead === 1 ? ' is' : 's are'} ahead of you. Please stay nearby.`,
        };
      }
      return {
        tone: 'waiting',
        headline: 'You are waiting.',
        detail: `${ahead} patients are ahead of you${entry.currentlyServingToken === null ? '' : `; token ${entry.currentlyServingToken} is being seen now`}. This page updates by itself.`,
      };
    }
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

export type QueueAction = 'checkIn' | 'checkOut' | 'skip' | 'return' | 'complete';

/**
 * The buttons that make sense for a patient in a given status, by role. The receptionist skips someone who is not here, returns a
 * skipped patient and checks out a completed one; the doctor completes the consultation and may skip a patient who is unavailable
 * (waiting, or called but absent). The server decides what is really allowed; a button offered here can still be refused.
 */
export function entryActions(role: 'RECEPTIONIST' | 'DOCTOR', status: QueueStatus): QueueAction[] {
  if (role === 'RECEPTIONIST') {
    if (status === 'WAITING' || status === 'SERVING') return ['skip'];
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
  startTime: string;
  endTime: string;
}

export interface DeskDoctor {
  doctor: { id: string; name: string; clinic: string };
  day: QueueDay;
  /** Confirmed appointments today whose patients have not been checked in yet, in appointment order. */
  arrivals: ArrivalRow[];
  /** Today's bookings still waiting for payment: they cannot be checked in yet. */
  awaitingPayment: ArrivalRow[];
}

const everyEntry = (day: QueueDay): QueueEntryView[] => [...(day.serving ? [day.serving] : []), ...day.waiting, ...day.completed, ...day.checkedOut, ...day.skipped, ...day.cancelled];

/**
 * The front desk's view: for each doctor, the live queue from the server and the appointments today that are still to arrive. An
 * appointment that already has a queue entry (in any state, even a cancelled one) is not listed as an arrival again.
 */
export function buildDesk(board: ReceptionBoard, appointments: ReceptionAppointment[]): DeskDoctor[] {
  const queued = new Set(board.doctors.flatMap((day) => everyEntry(day).map((entry) => entry.appointmentId)));
  return board.doctors.map((day) => {
    const { doctor } = day;
    const todays = appointments
      .filter((appointment) => appointment.doctor.id === doctor.id && appointment.date === board.date && !queued.has(appointment.id))
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.patient.name.localeCompare(b.patient.name))
      .map((appointment) => ({ appointment, row: { appointmentId: appointment.id, patientName: appointment.patient.name, startTime: appointment.startTime, endTime: appointment.endTime } }));
    return {
      doctor,
      day,
      arrivals: todays.filter(({ appointment }) => appointment.status === 'CONFIRMED').map(({ row }) => row),
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
  }
}

/** The administrator's totals across every doctor, for the summary line. */
export function adminTotals(board: AdminQueueBoard): QueueCounts {
  const total: QueueCounts = { waiting: 0, serving: 0, completed: 0, checkedOut: 0, skipped: 0, cancelled: 0 };
  for (const { counts } of board.doctors) for (const key of Object.keys(total) as (keyof QueueCounts)[]) total[key] += counts[key];
  return total;
}
