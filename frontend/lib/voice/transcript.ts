/** Judging what the recogniser heard: is it worth sending, is it a repeat, is it the assistant's own voice coming back. */

export const cleanTranscript = (text: string): string => text.replace(/\s+/g, ' ').trim();

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'hmm', 'hm', 'mm', 'mmm', 'ah', 'ahh', 'er', 'erm', 'uh-huh', 'अं', 'हम्म', 'ऊं']);

/** Something worth sending: at least two letters or digits, and not only a filler sound. Silence and noise come back as nothing at all. */
export function isMeaningful(text: string): boolean {
  const cleaned = cleanTranscript(text).toLowerCase();
  if ((cleaned.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return false;
  const words = cleaned.split(/[\s,.!?।]+/).filter(Boolean);
  return words.some((word) => !FILLERS.has(word));
}

const wordsOf = (text: string): string[] => cleanTranscript(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The same thing heard twice in a row (a browser that fires a result twice, or a restart that replays it) is sent once. */
export class DuplicateGuard {
  private last: { key: string; at: number } | null = null;

  constructor(private readonly windowMs = 4000) {}

  /** True when this text is new (and remembers it); false for a repeat of the previous one within the window. */
  accept(text: string, now: number): boolean {
    const key = wordsOf(text).join(' ');
    if (this.last && this.last.key === key && now - this.last.at < this.windowMs) return false;
    this.last = { key, at: now };
    return true;
  }

  reset(): void {
    this.last = null;
  }
}

/**
 * Whether what was "heard" is really the assistant's own voice from the speakers: a long phrase whose words come, almost all, in the same
 * ORDER as words the assistant said in the last few seconds. Order matters because a person answering an offer repeats its words in
 * their own order ("book the 9:30 slot tomorrow"), while an echo repeats the sentence itself. Short phrases are never treated as an echo
 * (dropping a real answer is worse), and the main protection against echo is that the microphone is off while the assistant speaks.
 */
export function looksLikeEcho(heard: string, spoken: { text: string; at: number }[], now: number, windowMs = 10_000, minWords = 6, share = 0.85): boolean {
  const words = wordsOf(heard);
  if (words.length < minWords) return false;
  const reference = spoken.filter((entry) => now - entry.at <= windowMs).flatMap((entry) => wordsOf(entry.text));
  if (reference.length === 0) return false;
  let from = 0;
  let matched = 0;
  for (const word of words) {
    const at = reference.indexOf(word, from);
    if (at >= 0) {
      matched++;
      from = at + 1;
    }
  }
  return matched / words.length >= share;
}
