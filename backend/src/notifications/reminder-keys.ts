/**
 * A reminder is identified by WHICH appointment, HOW FAR BEFORE it (the interval) and WHICH channel. This module is the one place
 * that turns those three things into the outbox's dedupe key and back, so the same reminder always has exactly one spelling and
 * can never be queued twice under two different-looking keys ("24" and "24.0", say).
 *
 *   reminder:<appointment id>:<hours>        the email
 *   reminder:<appointment id>:<hours>:sms    the text
 */
export type ReminderChannel = 'email' | 'sms';

/** The interval written one way only: 24 -> "24", 0.5 -> "0.5", 1.0 -> "1". */
export function canonicalHours(hours: number): string {
  return String(Number(hours.toFixed(4)));
}

export function reminderKey(appointmentId: string, hours: number, channel: ReminderChannel = 'email'): string {
  const base = `reminder:${appointmentId}:${canonicalHours(hours)}`;
  return channel === 'sms' ? `${base}:sms` : base;
}

/** The parts of a reminder key, or null for a key that is not a reminder's (those are left alone). */
export function parseReminderKey(key: string): { appointmentId: string; hours: number; channel: ReminderChannel } | null {
  const match = /^reminder:([0-9a-f-]{36}):([0-9]+(?:\.[0-9]+)?)(:sms)?$/i.exec(key);
  if (!match) return null;
  const hours = Number(match[2]);
  return hours > 0 ? { appointmentId: match[1], hours, channel: match[3] ? 'sms' : 'email' } : null;
}

/** The identity of "a reminder": the same appointment, interval and channel is the same reminder, whatever its key looked like. */
export function reminderSlot(appointmentId: string, hours: number, channel: ReminderChannel): string {
  return `${appointmentId}:${canonicalHours(hours)}:${channel}`;
}
