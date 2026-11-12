import { canonicalHours } from './reminder-keys.js';

export type NotificationCategory = 'transactional' | 'reminder' | 'promotional';
export type ChannelName = 'email' | 'sms';

/** A patient's choices. Essential appointment emails are deliberately not here: they are always sent. */
export interface NotificationPreferences {
  /** Also send essential updates by text. Turning this off never stops the email. It also switches off every other text. */
  smsEnabled: boolean;
  emailReminders: boolean;
  smsReminders: boolean;
  /** Explicit opt-ins to promotional messages. Off unless the patient ticked them. */
  promotionalEmail: boolean;
  promotionalSms: boolean;
}

/** What a patient with no saved preferences gets: everything they need, and nothing promotional. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  smsEnabled: true,
  emailReminders: true,
  smsReminders: true,
  promotionalEmail: false,
  promotionalSms: false,
};

/**
 * Whether a message of this category may go out on this channel to someone with these preferences. Used twice: when a message is
 * queued, and again just before it is delivered (a patient can change their mind in between).
 *
 * - transactional: the email always goes; the text goes unless the patient turned texts off. So an essential update is never
 *   lost: switching off texts leaves the email, and there is no way to switch the email off.
 * - reminder: optional, per channel; a text also needs texts to be on.
 * - promotional: only with the explicit opt-in for that channel (and, for texts, texts on).
 */
export function mayDeliver(preferences: NotificationPreferences, category: NotificationCategory, channel: ChannelName): boolean {
  if (category === 'transactional') return channel === 'email' ? true : preferences.smsEnabled;
  if (category === 'reminder') return channel === 'email' ? preferences.emailReminders : preferences.smsEnabled && preferences.smsReminders;
  return channel === 'email' ? preferences.promotionalEmail : preferences.smsEnabled && preferences.promotionalSms;
}

/** A category name from the database, narrowed. Anything unrecognised is treated as promotional, the most restricted, never as essential. */
export function categoryOf(value: string): NotificationCategory {
  return value === 'transactional' || value === 'reminder' ? value : 'promotional';
}

/**
 * When each reminder should go out for an appointment starting at `start`: `hoursBefore` earlier, for each configured interval.
 * Only times still in the future are kept (an interval that has already passed is not sent late as if it were on time).
 * `start` is a real instant, worked out from the clinic's local date and time, so this is correct in any time zone and across
 * daylight-saving changes: "24 hours before" is always 24 real hours.
 */
export function reminderSchedule(start: Date, hoursBefore: number[], now: Date): { hours: number; sendAt: Date }[] {
  // The same interval listed twice ("24,24" or "24,24.0") is still one reminder.
  const intervals = [...new Map(hoursBefore.map((hours) => [canonicalHours(hours), hours])).values()];
  return intervals
    .map((hours) => ({ hours, sendAt: new Date(start.getTime() - hours * 3_600_000) }))
    .filter(({ sendAt }) => sendAt.getTime() > now.getTime());
}
