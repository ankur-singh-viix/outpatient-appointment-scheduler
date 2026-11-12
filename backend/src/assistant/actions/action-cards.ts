import type { AssistantActionKind } from '../../database/entities/assistant-action.entity.js';

/**
 * What the patient is shown before pressing Confirm. The server writes it from real data (the model never does), so what the card
 * says is what the confirmation will do.
 */
export interface ActionCard {
  /** The confirmation reference. Honoured only for the patient it was made for, once, before it expires. */
  ref: string;
  /** A patient's BOOK / RESCHEDULE / CANCEL, or a doctor's SCHEDULE_CHANGE (whose `ref` is a signed token, not a stored row). */
  kind: AssistantActionKind | 'SCHEDULE_CHANGE';
  title: string;
  lines: { label: string; value: string }[];
  /** One short extra sentence, such as what happens to a payment. */
  note?: string;
  confirmLabel: string;
  dismissLabel: string;
  expiresAt: string;
}

export const dateLabel = (date: string): string => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

export function timeLabel(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
}

export const rangeLabel = (start: string, end: string): string => `${timeLabel(start)} – ${timeLabel(end)}`;

export const rupees = (paise: number): string => `Rs. ${paise % 100 === 0 ? paise / 100 : (paise / 100).toFixed(2)}`;
