import { describe, expect, it, vi } from 'vitest';
import { issueBookedQueueToken } from './issue-token.js';

describe('issueBookedQueueToken', () => {
  it('returns the existing token without allocating another when the appointment already has an entry', async () => {
    const existing = { id: 'entry-1', tokenNumber: 7, appointmentId: 'appt-1' };
    const manager = {
      findOneBy: vi.fn().mockResolvedValue(existing),
      query: vi.fn(),
      create: vi.fn(),
      save: vi.fn(),
      insert: vi.fn(),
    };
    const result = await issueBookedQueueToken(manager as never, {
      appointmentId: 'appt-1',
      doctorId: 'doc-1',
      patientId: 'pat-1',
      queueDate: '2026-11-17',
      actorUserId: 'user-1',
    });
    expect(result).toEqual({ entryId: 'entry-1', tokenNumber: 7 });
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('allocates MAX(token)+1 and writes a BOOKED entry with null check-in fields plus a BOOKED audit event', async () => {
    const saved = { id: 'entry-2', tokenNumber: 3 };
    const created: Record<string, unknown>[] = [];
    const manager = {
      findOneBy: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue([{ next: 3 }]),
      create: vi.fn((_entity: unknown, data: Record<string, unknown>) => {
        created.push(data);
        return data;
      }),
      save: vi.fn().mockResolvedValue(saved),
      insert: vi.fn().mockResolvedValue(undefined),
    };
    const result = await issueBookedQueueToken(manager as never, {
      appointmentId: 'appt-2',
      doctorId: 'doc-1',
      patientId: 'pat-2',
      queueDate: '2026-11-17',
      actorUserId: 'user-2',
    });
    expect(result).toEqual({ entryId: 'entry-2', tokenNumber: 3 });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('MAX(token_number)'), ['doc-1', '2026-11-17']);
    expect(created[0]).toEqual(
      expect.objectContaining({
        appointmentId: 'appt-2',
        status: 'BOOKED',
        tokenNumber: 3,
        checkedInAt: null,
        checkedInByUserId: null,
      }),
    );
    expect(created[0].checkedInAt).toBeNull();
    expect(created[0].checkedInByUserId).toBeNull();
    expect(manager.save).toHaveBeenCalledWith(created[0]);
    expect(manager.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'BOOKED', fromStatus: null, toStatus: 'BOOKED', actorUserId: 'user-2' }),
    );
  });

  it('never allocates a second token for the same appointment on a repeated call', async () => {
    const existing = { id: 'entry-9', tokenNumber: 9, appointmentId: 'appt-9' };
    const manager = {
      findOneBy: vi.fn().mockResolvedValue(existing),
      query: vi.fn(),
      create: vi.fn(),
      save: vi.fn(),
      insert: vi.fn(),
    };
    const first = await issueBookedQueueToken(manager as never, {
      appointmentId: 'appt-9',
      doctorId: 'doc-1',
      patientId: 'pat-9',
      queueDate: '2026-11-17',
      actorUserId: 'user-9',
    });
    const second = await issueBookedQueueToken(manager as never, {
      appointmentId: 'appt-9',
      doctorId: 'doc-1',
      patientId: 'pat-9',
      queueDate: '2026-11-17',
      actorUserId: 'user-9',
    });
    expect(first).toEqual(second);
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
