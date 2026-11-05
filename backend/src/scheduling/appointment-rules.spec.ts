import { changeBlockedReason } from './appointment-rules.js';

const now = { date: '2026-11-10', time: '12:00' };
const future = { status: 'CONFIRMED', date: '2026-11-12', startTime: '09:00:00' };

describe('changeBlockedReason', () => {
  it('allows changing a confirmed or pending appointment in the future', () => {
    expect(changeBlockedReason(future, now)).toBeNull();
    expect(changeBlockedReason({ ...future, status: 'PENDING' }, now)).toBeNull();
  });

  it('allows a later appointment today', () => {
    expect(changeBlockedReason({ ...future, date: now.date, startTime: '12:15:00' }, now)).toBeNull();
  });

  it('blocks appointments that are already cancelled, completed or no-show', () => {
    expect(changeBlockedReason({ ...future, status: 'CANCELLED' }, now)).toMatch(/already cancelled/);
    expect(changeBlockedReason({ ...future, status: 'COMPLETED' }, now)).toMatch(/already completed/);
    expect(changeBlockedReason({ ...future, status: 'NO_SHOW' }, now)).toMatch(/already no show/);
  });

  it('blocks appointments on a past date', () => {
    expect(changeBlockedReason({ ...future, date: '2026-11-09' }, now)).toMatch(/already started or passed/);
  });

  it('blocks an appointment today that starts at or before the current time', () => {
    expect(changeBlockedReason({ ...future, date: now.date, startTime: '12:00:00' }, now)).toMatch(/already started/);
    expect(changeBlockedReason({ ...future, date: now.date, startTime: '09:30:00' }, now)).toMatch(/already started/);
  });

  it('reports the status before the time when both apply', () => {
    expect(changeBlockedReason({ status: 'CANCELLED', date: '2026-01-01', startTime: '09:00' }, now)).toMatch(/cancelled/);
  });
});
