import { APPOINTMENT_STATUSES, type AppointmentStatus } from '../database/entities/appointment.entity.js';
import { APPOINTMENT_TRANSITIONS, assertTransition, canTransition, QUEUE_STATUSES_BLOCKING_AUTO_COMPLETE } from './appointment-lifecycle.js';

describe('appointment lifecycle', () => {
  it('has an entry for every status; cancelled and completed stay final, no-show may reopen to confirmed', () => {
    expect(Object.keys(APPOINTMENT_TRANSITIONS).sort((x, y) => x.localeCompare(y))).toEqual([...APPOINTMENT_STATUSES].sort((x, y) => x.localeCompare(y)));
    for (const final of ['CANCELLED', 'COMPLETED'] as AppointmentStatus[]) expect(APPOINTMENT_TRANSITIONS[final]).toEqual([]);
    expect(APPOINTMENT_TRANSITIONS.NO_SHOW).toEqual(['CONFIRMED']);
  });

  it('allows exactly the moves the domain has', () => {
    const allowed: [AppointmentStatus, AppointmentStatus][] = [
      ['PENDING', 'CONFIRMED'],
      ['PENDING', 'CANCELLED'],
      ['CONFIRMED', 'CANCELLED'],
      ['CONFIRMED', 'COMPLETED'],
      ['CONFIRMED', 'NO_SHOW'],
      ['NO_SHOW', 'CONFIRMED'],
    ];
    for (const from of APPOINTMENT_STATUSES) {
      for (const to of APPOINTMENT_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.some(([f, t]) => f === from && t === to));
      }
    }
  });

  it('never lets cancelled or completed appointments be reopened; no-show may return to confirmed only', () => {
    for (const from of ['CANCELLED', 'COMPLETED'] as AppointmentStatus[]) {
      for (const to of APPOINTMENT_STATUSES) expect(() => assertTransition(from, to)).toThrow(/cannot become/);
    }
    expect(() => assertTransition('NO_SHOW', 'CONFIRMED')).not.toThrow();
    expect(() => assertTransition('NO_SHOW', 'COMPLETED')).toThrow(/cannot become/);
  });

  it('explains a refused move in plain words', () => {
    expect(() => assertTransition('COMPLETED', 'CANCELLED')).toThrow('This appointment is completed and cannot become cancelled.');
    expect(() => assertTransition('NO_SHOW', 'COMPLETED')).toThrow('This appointment is no show and cannot become completed.');
    expect(() => assertTransition('PENDING', 'CONFIRMED')).not.toThrow();
  });

  it('blocks auto-complete for BOOKED so late arrival stays available after grace', () => {
    expect(QUEUE_STATUSES_BLOCKING_AUTO_COMPLETE).toContain('BOOKED');
    expect(QUEUE_STATUSES_BLOCKING_AUTO_COMPLETE).toEqual(['BOOKED', 'WAITING', 'SERVING', 'SKIPPED']);
  });
});
