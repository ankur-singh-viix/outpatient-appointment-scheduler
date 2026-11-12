import { describe, expect, it } from 'vitest';
import { DuplicateGuard, cleanTranscript, isMeaningful, looksLikeEcho } from './transcript';

describe('isMeaningful: what is worth sending', () => {
  it('rejects empty, whitespace, punctuation and filler sounds', () => {
    for (const text of ['', '   ', '...', '?', 'a', 'um', 'Umm.', 'uh uh', 'hmm', 'अं']) expect(isMeaningful(text)).toBe(false);
  });
  it('accepts real speech in English, Hindi and Hinglish, including one short word', () => {
    for (const text of ['yes', 'no', 'tomorrow', 'mere upcoming appointments dikhao', 'मेरे अपॉइंटमेंट दिखाओ', 'Show my appointments', '10', 'um, the 9 AM one']) expect(isMeaningful(text)).toBe(true);
  });
  it('normalises spacing', () => {
    expect(cleanTranscript('  show   my \n appointments ')).toBe('show my appointments');
  });
});

describe('DuplicateGuard', () => {
  it('accepts new text and refuses the same text again within the window', () => {
    const guard = new DuplicateGuard(4000);
    expect(guard.accept('show my appointments', 1000)).toBe(true);
    expect(guard.accept('Show my appointments!', 2500)).toBe(false); // same words, different case and punctuation
    expect(guard.accept('show my appointments', 6000)).toBe(true); // asked again later: a new request
    expect(guard.accept('book tomorrow', 6100)).toBe(true);
  });
  it('can be reset', () => {
    const guard = new DuplicateGuard();
    guard.accept('hello there', 0);
    guard.reset();
    expect(guard.accept('hello there', 1)).toBe(true);
  });
});

describe('looksLikeEcho: the assistant hearing itself', () => {
  const spoken = [{ text: 'You have two appointments this week, the next one is with Dr. Rao tomorrow at 9:30 AM.', at: 10_000 }];
  it('flags text that is mostly what the assistant just said', () => {
    expect(looksLikeEcho('you have two appointments this week the next one is with doctor rao', spoken, 12_000)).toBe(true);
    expect(looksLikeEcho('next one is with Dr. Rao tomorrow at 9:30 AM', spoken, 12_000)).toBe(true);
  });
  it('lets the person answer, even with the same few words, and ignores old speech', () => {
    expect(looksLikeEcho('cancel the next one please', spoken, 12_000)).toBe(false);
    expect(looksLikeEcho('yes', spoken, 12_000)).toBe(false); // too short to judge: never dropped
    expect(looksLikeEcho('tomorrow at 9:30', spoken, 12_000)).toBe(false);
    expect(looksLikeEcho('please book the 9:30 AM slot tomorrow with Dr. Rao', spoken, 12_000)).toBe(false); // the same words, in the person's own order
    expect(looksLikeEcho('this week you have two appointments with the next one', spoken, 12_000)).toBe(false); // the same words, out of order: a person, not an echo
    expect(looksLikeEcho('you have two appointments this week the next one', spoken, 40_000)).toBe(false); // spoken long ago
    expect(looksLikeEcho('anything at all here now', [], 12_000)).toBe(false);
  });
});
