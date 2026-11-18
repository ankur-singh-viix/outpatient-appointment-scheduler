import type { ConversationSummary, StoredMessage } from './types';

/** What a saved conversation shows under a reply that once had a confirmation card. Never a live button: nothing stored can confirm anything. */
export const CARD_EXPIRED_TEXT = 'Card expired';

/** A saved message in the shape the chat shows. Cards are never rebuilt: `cardExpired` only makes the chat print "Card expired". */
export interface LoadedTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolNames: string[];
  cardExpired: boolean;
}

/** Saved messages as chat turns, in the order given. Only an assistant reply can have had a card. */
export function turnsFromStored(messages: StoredMessage[]): LoadedTurn[] {
  return messages.map((message) => ({
    id: `saved-${message.id}`,
    role: message.role,
    content: message.text,
    toolNames: message.role === 'assistant' ? message.toolNames : [],
    cardExpired: message.role === 'assistant' && message.hadCard,
  }));
}

/** "Just now", "5 min ago", "2 h ago", "Yesterday", "3 days ago", then the date. `now` is a parameter so this is predictable. */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const ms = now.getTime() - then.getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'Just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).format(then);
}

/** Puts a conversation first in the list (it was just used), keeping the rest in order and adding it if it was not there. */
export function bumpConversation(list: ConversationSummary[], conversation: ConversationSummary): ConversationSummary[] {
  return [conversation, ...list.filter((entry) => entry.id !== conversation.id)];
}

/** The list after more pages arrive: no conversation twice, even if the first page changed in between. */
export function appendPage(list: ConversationSummary[], page: ConversationSummary[]): ConversationSummary[] {
  const seen = new Set(list.map((entry) => entry.id));
  return [...list, ...page.filter((entry) => !seen.has(entry.id))];
}
