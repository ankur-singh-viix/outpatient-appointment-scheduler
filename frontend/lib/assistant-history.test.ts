import { describe, expect, it } from 'vitest';
import { CARD_EXPIRED_TEXT, appendPage, bumpConversation, relativeDate, turnsFromStored } from './assistant-history';
import type { ConversationSummary, StoredMessage } from './types';

const message = (patch: Partial<StoredMessage>): StoredMessage => ({ id: 'm1', role: 'assistant', text: 'hello', toolNames: [], hadCard: false, createdAt: '2026-11-13T10:00:00Z', ...patch });
const conversation = (id: string): ConversationSummary => ({ id, title: `chat ${id}`, createdAt: '2026-11-13T10:00:00Z', updatedAt: '2026-11-13T10:00:00Z' });

describe('turnsFromStored', () => {
  it('keeps the order, the text and the lookups used', () => {
    const turns = turnsFromStored([message({ id: 'a', role: 'user', text: 'hi' }), message({ id: 'b', text: 'you have none', toolNames: ['get_my_appointments'] })]);
    expect(turns.map((turn) => [turn.role, turn.content, turn.toolNames])).toEqual([
      ['user', 'hi', []],
      ['assistant', 'you have none', ['get_my_appointments']],
    ]);
  });

  it('marks a reply that had a card as expired, and never gives anything that could be pressed', () => {
    const [turn] = turnsFromStored([message({ hadCard: true, text: 'A card is waiting.' })]);
    expect(turn).toEqual({ id: 'saved-m1', role: 'assistant', content: 'A card is waiting.', toolNames: [], cardExpired: true });
    expect(Object.keys(turn)).not.toContain('cards'); // there is no card data to render, only the marker
    expect(CARD_EXPIRED_TEXT).toBe('Card expired');
  });

  it('never marks a person\'s own message as having a card', () => {
    expect(turnsFromStored([message({ role: 'user', hadCard: true })])[0].cardExpired).toBe(false);
  });

  it('gives each saved message an id that cannot collide with a live turn', () => {
    expect(turnsFromStored([message({ id: 'x' })])[0].id).toBe('saved-x');
  });
});

describe('relativeDate', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it.each([
    [10_000, 'Just now'],
    [5 * 60_000, '5 min ago'],
    [3 * 3_600_000, '3 h ago'],
    [30 * 3_600_000, 'Yesterday'],
    [4 * 86_400_000, '4 days ago'],
  ])('%i ms ago reads %s', (ms, text) => expect(relativeDate(ago(ms), now)).toBe(text));

  it('falls back to a date for older chats, with the year only when it is another year', () => {
    expect(relativeDate('2026-10-01T10:00:00Z', now)).toBe('1 Oct');
    expect(relativeDate('2025-10-01T10:00:00Z', now)).toBe('1 Oct 2025');
  });

  it('says nothing for a date it cannot read, rather than "NaN"', () => {
    expect(relativeDate('nonsense', now)).toBe('');
  });
});

describe('list helpers', () => {
  it('bumps a used conversation to the top once, and adds a new one', () => {
    expect(bumpConversation([conversation('a'), conversation('b'), conversation('c')], conversation('c')).map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    expect(bumpConversation([conversation('a')], conversation('z')).map((entry) => entry.id)).toEqual(['z', 'a']);
  });

  it('appends a later page without repeating any conversation', () => {
    expect(appendPage([conversation('a'), conversation('b')], [conversation('b'), conversation('c')]).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});
