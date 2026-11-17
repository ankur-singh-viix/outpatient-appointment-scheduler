import { describe, expect, it } from 'vitest';
import { actionNotice, adminTotals, aheadText, buildDesk, canCallNext, entryActions, patientMessage, progress, STATUS_LABEL } from './queue-view';
import type { AdminQueueBoard, QueueCounts, QueueDay, QueueEntryResult, QueueEntryView, QueueStatus, ReceptionAppointment, ReceptionBoard } from './types';

const entry = (token: number, status: QueueStatus, appointmentId = `appt-${token}`): QueueEntryView => ({
  id: `entry-${token}`,
  appointmentId,
  token,
  status,
  appointment: { startTime: '09:00', endTime: '09:30' },
  patient: { name: `Patient ${token}` },
  checkedInAt: '2026-11-16T04:00:00Z',
  calledAt: null,
  completedAt: null,
  checkedOutAt: null,
});
const counts = (patch: Partial<QueueCounts> = {}): QueueCounts => ({ waiting: 0, serving: 0, completed: 0, checkedOut: 0, skipped: 0, cancelled: 0, ...patch });
const day = (patch: Partial<QueueDay> = {}): QueueDay => ({ date: '2026-11-16', currentlyServingToken: null, serving: null, booked: [], waiting: [], completed: [], checkedOut: [], skipped: [], cancelled: [], counts: counts(), updatedAt: '2026-11-16T04:00:00Z', ...patch });
const appointment = (id: string, doctorId: string, startTime: string, status: 'CONFIRMED' | 'PENDING' = 'CONFIRMED', date = '2026-11-16', name = `Patient ${id}`, queueToken: number | null = null): ReceptionAppointment => ({
  id,
  date,
  startTime,
  endTime: '10:00',
  status,
  slotNumber: 1,
  slotCapacity: 1,
  queueToken,
  patient: { id: `p-${id}`, name, phone: '+911' },
  doctor: { id: doctorId, name: doctorId },
});

describe('patientMessage: what a patient waiting at the clinic is told', () => {
  it('says "you are waiting" while several are ahead, with who is being seen', () => {
    expect(patientMessage({ status: 'WAITING', ahead: 5, currentlyServingToken: 4 })).toEqual({
      tone: 'waiting',
      headline: 'You are waiting.',
      detail: '5 patients are ahead of you; token 4 is being seen now. This page updates by itself.',
    });
    expect(patientMessage({ status: 'WAITING', ahead: 3, currentlyServingToken: null }).detail).toBe('3 patients are ahead of you. This page updates by itself.');
  });

  it('says the turn is approaching when two or fewer are ahead', () => {
    expect(patientMessage({ status: 'WAITING', ahead: 2, currentlyServingToken: 1 })).toMatchObject({ tone: 'soon', headline: 'Your turn is approaching.', detail: '2 patients are ahead of you. Please stay nearby.' });
    expect(patientMessage({ status: 'WAITING', ahead: 1, currentlyServingToken: 1 }).detail).toBe('1 patient is ahead of you. Please stay nearby.');
    expect(patientMessage({ status: 'WAITING', ahead: 0, currentlyServingToken: null }).detail).toBe('You are next. Please stay close to the consultation room.');
  });

  it('tells a patient who has been called to go in, and that the consultation is in progress', () => {
    expect(patientMessage({ status: 'SERVING', ahead: 0, currentlyServingToken: 7 })).toEqual({ tone: 'now', headline: 'Please proceed to the consultation room.', detail: 'Your consultation is in progress.' });
  });

  it('covers the rest of the day: completed, checked out, skipped and cancelled', () => {
    expect(patientMessage({ status: 'COMPLETED', ahead: null, currentlyServingToken: null }).headline).toBe('Your consultation is completed.');
    expect(patientMessage({ status: 'CHECKED_OUT', ahead: null, currentlyServingToken: null }).headline).toBe('You have checked out.');
    expect(patientMessage({ status: 'SKIPPED', ahead: null, currentlyServingToken: 3 })).toMatchObject({ tone: 'attention', headline: 'You were skipped.' });
    expect(patientMessage({ status: 'SKIPPED', ahead: null, currentlyServingToken: 3 }).detail).toMatch(/front desk/);
    expect(patientMessage({ status: 'CANCELLED', ahead: null, currentlyServingToken: null }).headline).toBe('This appointment was cancelled.');
  });

  it('has a word for every status', () => {
    for (const status of Object.keys(STATUS_LABEL) as QueueStatus[]) expect(patientMessage({ status, ahead: 4, currentlyServingToken: null }).headline.length).toBeGreaterThan(0);
    expect(STATUS_LABEL.WAITING).toBe('Waiting');
    expect(STATUS_LABEL.SERVING).toBe('Serving');
    expect(STATUS_LABEL.COMPLETED).toBe('Completed');
    expect(STATUS_LABEL.SKIPPED).toBe('Skipped');
  });
});

describe('aheadText', () => {
  it('reads naturally', () => {
    expect(aheadText(0)).toBe('You are next');
    expect(aheadText(1)).toBe('1 patient ahead');
    expect(aheadText(6)).toBe('6 patients ahead');
    expect(aheadText(null)).toBe('–');
  });
});

describe('entryActions: which buttons each role is offered', () => {
  it('lets the receptionist skip a waiting patient, complete or skip one being served, return a skipped one, and check out a completed one', () => {
    expect(entryActions('RECEPTIONIST', 'WAITING')).toEqual(['skip']);
    expect(entryActions('RECEPTIONIST', 'SERVING')).toEqual(['complete', 'skip']);
    expect(entryActions('RECEPTIONIST', 'SKIPPED')).toEqual(['return']);
    expect(entryActions('RECEPTIONIST', 'COMPLETED')).toEqual(['checkOut']);
  });

  it('offers a receptionist nothing for a patient who has left', () => {
    expect(entryActions('RECEPTIONIST', 'CHECKED_OUT')).toEqual([]);
    expect(entryActions('RECEPTIONIST', 'CANCELLED')).toEqual([]);
  });

  it('lets the doctor complete the patient being served and skip one who is unavailable, but not check out or return anyone', () => {
    expect(entryActions('DOCTOR', 'SERVING')).toEqual(['complete', 'skip']);
    expect(entryActions('DOCTOR', 'WAITING')).toEqual(['skip']);
    for (const status of Object.keys(STATUS_LABEL) as QueueStatus[]) {
      expect(entryActions('DOCTOR', status)).not.toContain('checkOut');
      expect(entryActions('DOCTOR', status)).not.toContain('return');
    }
    expect(entryActions('DOCTOR', 'COMPLETED')).toEqual([]);
  });
});

describe('canCallNext', () => {
  it('only when nobody is being served and somebody is waiting', () => {
    expect(canCallNext(day({ waiting: [entry(1, 'WAITING')] }))).toBe(true);
    expect(canCallNext(day({ serving: entry(1, 'SERVING'), waiting: [entry(2, 'WAITING')] }))).toBe(false);
    expect(canCallNext(day())).toBe(false);
  });
});

describe('progress', () => {
  it('counts seen patients of everyone in the queue, and leaves cancelled ones out', () => {
    expect(progress(counts({ waiting: 2, serving: 1, completed: 1, checkedOut: 2, skipped: 1, cancelled: 4 }))).toEqual({ total: 7, done: 3, percent: 43 });
    expect(progress(counts())).toEqual({ total: 0, done: 0, percent: 0 });
    expect(progress(counts({ checkedOut: 3 }))).toEqual({ total: 3, done: 3, percent: 100 });
  });
});

describe('buildDesk: the front desk, one doctor at a time', () => {
  const board: ReceptionBoard = {
    date: '2026-11-16',
    doctors: [
      { ...day({ serving: entry(1, 'SERVING', 'a1'), waiting: [entry(2, 'WAITING', 'a2')], counts: counts({ waiting: 1, serving: 1 }) }), doctor: { id: 'dr-1', name: 'Dr. One', clinic: 'Clinic' } },
      { ...day(), doctor: { id: 'dr-2', name: 'Dr. Two', clinic: 'Clinic' } },
    ],
  };

  it('lists as arrivals the confirmed appointments of today that have no queue entry yet, in appointment order', () => {
    const desk = buildDesk(board, [
      appointment('a1', 'dr-1', '09:00', 'CONFIRMED', '2026-11-16', 'Patient a1', 1),
      appointment('a2', 'dr-1', '09:30', 'CONFIRMED', '2026-11-16', 'Patient a2', 2),
      appointment('a3', 'dr-1', '11:00', 'CONFIRMED', '2026-11-16', 'Patient a3', 3),
      appointment('a4', 'dr-1', '10:00', 'CONFIRMED', '2026-11-16', 'Patient a4', 4),
      appointment('b1', 'dr-2', '10:00', 'CONFIRMED', '2026-11-16', 'Patient b1', 1),
    ]);
    expect(desk.map((doctor) => doctor.doctor.name)).toEqual(['Dr. One', 'Dr. Two']);
    expect(desk[0].arrivals.map((row) => row.appointmentId)).toEqual(['a4', 'a3']); // a1 and a2 are already in the queue
    expect(desk[0].arrivals.map((row) => row.token)).toEqual([4, 3]);
    expect(desk[1].arrivals.map((row) => row.appointmentId)).toEqual(['b1']);
    expect(desk[0].day.waiting.map((row) => row.token)).toEqual([2]);
  });

  it('lists BOOKED queue entries (token already issued) as arrivals before check-in', () => {
    const withBooked: ReceptionBoard = {
      date: '2026-11-16',
      doctors: [
        {
          ...day({
            booked: [entry(9, 'BOOKED', 'booked-1')],
            counts: counts({ booked: 1 }),
          }),
          doctor: { id: 'dr-1', name: 'Dr. One', clinic: 'Clinic' },
        },
      ],
    };
    withBooked.doctors[0].booked![0] = {
      ...withBooked.doctors[0].booked![0],
      appointment: { startTime: '10:15', endTime: '10:45' },
      patient: { name: 'Booked Patient', phone: '+911' },
      checkedInAt: null,
    };
    const desk = buildDesk(withBooked, []);
    expect(desk[0].arrivals).toEqual([
      { appointmentId: 'booked-1', patientName: 'Booked Patient', phone: '+911', startTime: '10:15', endTime: '10:45', token: 9 },
    ]);
  });

  it('keeps a booking that is still waiting for payment apart: it cannot be checked in', () => {
    const desk = buildDesk(board, [appointment('a5', 'dr-1', '10:00', 'PENDING'), appointment('a6', 'dr-1', '10:30', 'CONFIRMED', '2026-11-16', 'Patient a6', 6)]);
    expect(desk[0].awaitingPayment.map((row) => row.appointmentId)).toEqual(['a5']);
    expect(desk[0].arrivals.map((row) => row.appointmentId)).toEqual(['a6']);
    expect(desk[0].arrivals[0].token).toBe(6);
  });

  it('ignores appointments of other days and of doctors who are not on the board', () => {
    const desk = buildDesk(board, [appointment('x1', 'dr-1', '10:00', 'CONFIRMED', '2026-11-17'), appointment('x2', 'dr-9', '10:00')]);
    expect(desk[0].arrivals).toEqual([]);
    expect(desk.flatMap((doctor) => doctor.arrivals)).toEqual([]);
  });

  it('does not list an appointment again once it has a queue entry in any state, a skipped or cancelled one included', () => {
    const withLeft: ReceptionBoard = { date: '2026-11-16', doctors: [{ ...day({ skipped: [entry(3, 'SKIPPED', 'a3')], cancelled: [entry(4, 'CANCELLED', 'a4')], checkedOut: [entry(5, 'CHECKED_OUT', 'a5')] }), doctor: { id: 'dr-1', name: 'Dr. One', clinic: 'Clinic' } }] };
    expect(buildDesk(withLeft, [appointment('a3', 'dr-1', '09:00'), appointment('a4', 'dr-1', '09:30'), appointment('a5', 'dr-1', '10:00')])[0].arrivals).toEqual([]);
  });

  it('copes with an empty board', () => {
    expect(buildDesk({ date: '2026-11-16', doctors: [] }, [appointment('a1', 'dr-1', '09:00')])).toEqual([]);
  });
});

describe('actionNotice: what is said after an action', () => {
  const result = (patch: Partial<QueueEntryResult> = {}): QueueEntryResult => ({
    ...entry(4, 'WAITING'),
    queueDate: '2026-11-16',
    doctor: { id: 'dr-1', name: 'Dr. One' },
    currentlyServingToken: 1,
    ahead: 3,
    behind: 0,
    ...patch,
  });

  it('gives the token and the place in the line at check-in', () => {
    expect(actionNotice('checkIn', result())).toBe('Checked in Patient 4: token 4. 3 patients ahead.');
    expect(actionNotice('checkIn', result({ ahead: 0 }))).toBe('Checked in Patient 4: token 4. You are next.');
  });

  it('names the patient and the token for every other action', () => {
    expect(actionNotice('callNext', result())).toBe('Called token 4, Patient 4.');
    expect(actionNotice('complete', result())).toBe('Completed the consultation for token 4, Patient 4.');
    expect(actionNotice('checkOut', result())).toBe('Checked out Patient 4 (token 4).');
    expect(actionNotice('skip', result())).toBe('Skipped token 4, Patient 4.');
    expect(actionNotice('return', result())).toBe('Returned token 4, Patient 4, to the queue.');
  });
});

describe('adminTotals', () => {
  it('adds up every doctor\'s counts', () => {
    const board: AdminQueueBoard = {
      date: '2026-11-16',
      doctors: [
        { doctor: { id: '1', name: 'A' }, clinic: 'C', currentlyServingToken: 2, lastTokenIssued: 5, counts: counts({ waiting: 2, serving: 1, completed: 1, skipped: 1 }), status: 'SERVING' },
        { doctor: { id: '2', name: 'B' }, clinic: 'C', currentlyServingToken: null, lastTokenIssued: 3, counts: counts({ waiting: 1, checkedOut: 2 }), status: 'WAITING' },
      ],
    };
    expect(adminTotals(board)).toEqual({ waiting: 3, serving: 1, completed: 1, checkedOut: 2, skipped: 1, cancelled: 0 });
  });
});
