import { APPOINTMENT_TRANSITIONS, assertTransition, canTransition } from './appointment-lifecycle.js';
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '../database/entities/appointment.entity.js';

describe('appointment lifecycle', () => {
  it('has an entry for every status, and the final ones lead nowhere', () => {
    expect(Object.keys(APPOINTMENT_TRANSITIONS).sort((x, y) => x.localeCompare(y))).toEqual([...APPOINTMENT_STATUSES].sort((x, y) => x.localeCompare(y)));
    for (const final of ['CANCELLED', 'COMPLETED', 'NO_SHOW'] as AppointmentStatus[]) expect(APPOINTMENT_TRANSITIONS[final]).toEqual([]);
  });

  it('allows exactly the moves the domain has', () => {
    const allowed: [AppointmentStatus, AppointmentStatus][] = [
      ['PENDING', 'CONFIRMED'],
      ['PENDING', 'CANCELLED'],
      ['CONFIRMED', 'CANCELLED'],
      ['CONFIRMED', 'COMPLETED'],
      ['CONFIRMED', 'NO_SHOW'],
    ];
    for (const from of APPOINTMENT_STATUSES) {
      for (const to of APPOINTMENT_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.some(([f, t]) => f === from && t === to));
      }
    }
  });

  it('never lets a final appointment be reopened or overwritten', () => {
    for (const from of ['CANCELLED', 'COMPLETED', 'NO_SHOW'] as AppointmentStatus[]) {
      for (const to of APPOINTMENT_STATUSES) expect(() => assertTransition(from, to)).toThrow(/cannot become/);
    }
  });

  it('explains a refused move in plain words', () => {
    expect(() => assertTransition('COMPLETED', 'CANCELLED')).toThrow('This appointment is completed and cannot become cancelled.');
    expect(() => assertTransition('NO_SHOW', 'COMPLETED')).toThrow('This appointment is no show and cannot become completed.');
    expect(() => assertTransition('PENDING', 'CONFIRMED')).not.toThrow();
  });
});
