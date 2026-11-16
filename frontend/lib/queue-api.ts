import type { AdminQueueBoard, DoctorQueue, MyQueueEntry, QueueEntryResult, ReceptionBoard, Session } from './types';

type Call = <T>(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown; token?: Session['accessToken'] }) => Promise<T>;

/**
 * The queue routes of the backend, one function each. The screens use only these and show only what the server answers: the order,
 * the positions and every rule (who may check in, who may be called) are the server's. Actions send an empty body, and the signed-in
 * person (never a parameter) decides whose queue they are in. `call` is the app's own API helper (see queue-client.ts); a test supplies another.
 */
export function createQueueApi(call: Call) {
  const get = <T>(session: Session, path: string) => call<T>(path, { token: session.accessToken });
  const post = (session: Session, path: string) => call<QueueEntryResult>(path, { method: 'POST', body: {}, token: session.accessToken });
  const withDate = (path: string, params: Record<string, string | undefined>) => {
    const query = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    return query.length > 0 ? `${path}?${query.join('&')}` : path;
  };
  return {
    // receptionist
    board: (session: Session, params: { doctorId?: string; date?: string } = {}) => get<ReceptionBoard>(session, withDate('/queue/reception', params)),
    checkIn: (session: Session, appointmentId: string) => post(session, `/queue/reception/appointments/${appointmentId}/check-in`),
    checkOut: (session: Session, entryId: string) => post(session, `/queue/reception/entries/${entryId}/check-out`),
    skipAtDesk: (session: Session, entryId: string) => post(session, `/queue/reception/entries/${entryId}/skip`),
    returnToQueue: (session: Session, entryId: string) => post(session, `/queue/reception/entries/${entryId}/return`),
    // doctor
    doctorQueue: (session: Session, date?: string) => get<DoctorQueue>(session, withDate('/queue/doctor', { date })),
    callNext: (session: Session) => post(session, '/queue/doctor/call-next'),
    complete: (session: Session, entryId: string) => post(session, `/queue/doctor/entries/${entryId}/complete`),
    skipAsDoctor: (session: Session, entryId: string) => post(session, `/queue/doctor/entries/${entryId}/skip`),
    // patient
    mine: (session: Session) => get<MyQueueEntry[]>(session, '/queue/mine'),
    // admin
    admin: (session: Session, date?: string) => get<AdminQueueBoard>(session, withDate('/queue/admin', { date })),
  };
}
