import { describe, expect, it, vi } from 'vitest';
import { createQueueApi } from './queue-api';
import type { Session } from './types';

const session = { accessToken: 'token-123', user: { id: 'u1', name: 'Test', role: 'RECEPTIONIST' } } as unknown as Session;

/** The request helper, recording what each call sent. */
function recorder(answer: unknown = {}) {
  const calls: { path: string; options: { method?: string; body?: unknown; token?: unknown } | undefined }[] = [];
  const call = vi.fn(async (path: string, options?: { method?: 'GET' | 'POST'; body?: unknown; token?: Session['accessToken'] }) => {
    calls.push({ path, options });
    return answer as never;
  });
  return { calls, queue: createQueueApi(call as never) };
}

describe('the queue API client', () => {
  it('reads with GET and the signed-in token, and never sends a body', async () => {
    const { calls, queue } = recorder();
    await queue.mine(session);
    await queue.doctorQueue(session);
    await queue.board(session);
    await queue.admin(session);
    expect(calls.map((call) => call.path)).toEqual(['/queue/mine', '/queue/doctor', '/queue/reception', '/queue/admin']);
    for (const call of calls) {
      expect(call.options).toEqual({ token: 'token-123' });
      expect(call.options?.method).toBeUndefined();
    }
  });

  it('passes the date and the doctor as query parameters, encoded, and leaves out what is not given', async () => {
    const { calls, queue } = recorder();
    await queue.doctorQueue(session, '2026-11-16');
    await queue.board(session, { doctorId: 'abc 1', date: '2026-11-16' });
    await queue.board(session, { doctorId: undefined });
    await queue.admin(session, '2026-11-15');
    expect(calls.map((call) => call.path)).toEqual(['/queue/doctor?date=2026-11-16', '/queue/reception?doctorId=abc%201&date=2026-11-16', '/queue/reception', '/queue/admin?date=2026-11-15']);
  });

  it('sends every action as a POST with an empty body: the server decides whose queue it is and what happens', async () => {
    const { calls, queue } = recorder();
    await queue.checkIn(session, 'appt-1');
    await queue.checkOut(session, 'entry-1');
    await queue.skipAtDesk(session, 'entry-2');
    await queue.returnToQueue(session, 'entry-3');
    await queue.callNext(session);
    await queue.complete(session, 'entry-4');
    await queue.skipAsDoctor(session, 'entry-5');
    expect(calls.map((call) => call.path)).toEqual([
      '/queue/reception/appointments/appt-1/check-in',
      '/queue/reception/entries/entry-1/check-out',
      '/queue/reception/entries/entry-2/skip',
      '/queue/reception/entries/entry-3/return',
      '/queue/doctor/call-next',
      '/queue/doctor/entries/entry-4/complete',
      '/queue/doctor/entries/entry-5/skip',
    ]);
    for (const call of calls) expect(call.options).toEqual({ method: 'POST', body: {}, token: 'token-123' });
  });

  it('never puts a doctor, a patient or a role in a request: nothing a person could change decides whose queue it is', async () => {
    const { calls, queue } = recorder();
    await queue.callNext(session);
    await queue.mine(session);
    expect(JSON.stringify(calls)).not.toMatch(/doctorId|patientId|userId|role/i);
  });

  it('hands back exactly what the server answered', async () => {
    const answer = { token: 4, status: 'WAITING', ahead: 3 };
    const { queue } = recorder(answer);
    expect(await queue.checkIn(session, 'appt-1')).toBe(answer);
  });

  it('lets a refusal from the server through untouched, so the screen can show its words', async () => {
    const refusal = Object.assign(new Error('Complete the consultation for token 3 before calling the next patient.'), { status: 409, code: 'CURRENT_NOT_COMPLETED' });
    const queue = createQueueApi((async () => Promise.reject(refusal)) as never);
    await expect(queue.callNext(session)).rejects.toBe(refusal);
    await expect(queue.mine(session)).rejects.toBe(refusal);
  });

  it('works with a token fetched fresh for each request (a function) as well as a stored one', async () => {
    const getter = async () => 'fresh';
    const { calls, queue } = recorder();
    await queue.mine({ ...session, accessToken: getter } as unknown as Session);
    expect(calls[0].options?.token).toBe(getter);
  });
});
