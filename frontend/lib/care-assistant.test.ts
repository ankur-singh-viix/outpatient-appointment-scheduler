import { describe, expect, it } from 'vitest';
import { TIP_KEY, assistantFooterText, launcherTip, launcherVisible, takeTip } from './care-assistant';

describe('launcherVisible: who sees the floating button, and where', () => {
  it.each(['/', '/appointments', '/payments', '/doctors/abc', '/doctor', '/doctor/availability', '/notifications', '/profile'])('shows for a patient and a doctor on %s', (path) => {
    expect(launcherVisible('PATIENT', path)).toBe(true);
    expect(launcherVisible('DOCTOR', path)).toBe(true);
  });

  it.each(['/assistant', '/assistant/anything', '/login', '/login/sso-callback', '/signup', '/signup/legacy', '/onboarding', '/invite', '/invite/abc', '/continue'])('hides on %s', (path) => {
    expect(launcherVisible('PATIENT', path)).toBe(false);
    expect(launcherVisible('DOCTOR', path)).toBe(false);
  });

  it('is not fooled by a page that only starts with the same letters', () => {
    expect(launcherVisible('PATIENT', '/assistants-directory')).toBe(true);
    expect(launcherVisible('PATIENT', '/logins')).toBe(true);
  });

  it('never shows for receptionists, admins, or a signed-out visitor', () => {
    for (const role of ['RECEPTIONIST', 'ADMIN', null, undefined] as const) expect(launcherVisible(role, '/')).toBe(false);
  });
});

describe('launcherTip', () => {
  it('says what a patient can do', () => {
    expect(launcherTip('PATIENT')).toBe('Book, reschedule or cancel appointments, check payments and refunds.');
  });
  it('says what a doctor can do', () => {
    expect(launcherTip('DOCTOR')).toBe('Manage your schedule: cancel or move appointments, add hours, block a day.');
  });
});

describe('takeTip: once per browser session', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
  };

  it('shows the first time, remembers it, and does not show again', () => {
    const storage = memory();
    expect(takeTip(storage)).toBe(true);
    expect(storage.data.get(TIP_KEY)).toBe('1');
    expect(takeTip(storage)).toBe(false);
    expect(takeTip(storage)).toBe(false);
  });

  it('a new session (empty storage) shows it again', () => {
    expect(takeTip(memory())).toBe(true);
  });

  it('still shows when storage is missing or blocked, instead of throwing', () => {
    expect(takeTip(null)).toBe(true);
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(takeTip(blocked)).toBe(true);
    const readOnly = { getItem: () => null, setItem: () => { throw new Error('full'); } };
    expect(takeTip(readOnly)).toBe(true);
  });
});

describe('assistantFooterText', () => {
  it('tells a patient what it can prepare, that Confirm is needed, and that it is not medical advice', () => {
    const text = assistantFooterText('PATIENT');
    expect(text).toMatch(/booking.*reschedule.*cancellation/);
    expect(text).toMatch(/press Confirm/);
    expect(text).toMatch(/not medical advice/);
  });

  it('tells a doctor the four things it can prepare, and no longer says it cannot change anything', () => {
    const text = assistantFooterText('DOCTOR');
    expect(text).toMatch(/cancellation.*move.*extra hours.*blocked day/);
    expect(text).toMatch(/press Confirm/);
    expect(text).not.toMatch(/cannot book, cancel or change anything/);
  });

  it('never promises to take payments', () => {
    for (const role of ['DOCTOR', 'PATIENT'] as const) expect(assistantFooterText(role)).not.toMatch(/pay(s|ment)? for|take payment|charge/i);
  });
});
