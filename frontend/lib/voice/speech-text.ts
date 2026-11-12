/**
 * Turning an assistant reply into something that is pleasant and safe to read aloud. The written reply stays exactly as it is on screen;
 * only the spoken copy is cleaned: markdown symbols, links, ids, tool names and JSON are never spoken, and the text is cut into short
 * sentence-sized pieces (browsers cut off or stall on one very long utterance) without ever splitting a word.
 */

export type Script = 'hi' | 'en';

/** Hindi (Devanagari) when a real share of the letters are Devanagari, otherwise English/Latin. One stray word does not decide it. */
export function scriptOf(text: string): Script {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 'en';
  const devanagari = text.match(/[ऀ-ॿ]/g) ?? [];
  return devanagari.length / letters.length >= 0.3 ? 'hi' : 'en';
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PROVIDER_IDS = /\b(?:order|pay|rfnd|rzp)_[A-Za-z0-9]+\b/g;
const TOOL_NAMES = /\b(?:get|prepare|suggest|search|find)_[a-z]+(?:_[a-z]+)*\b/g;

/** The text to speak for a reply: no markdown, links, ids, tool names or JSON; money and line breaks made speakable. */
export function toSpeakable(input: string): string {
  const hindi = scriptOf(input) === 'hi';
  let text = input;
  text = text.replace(/```[\s\S]*?```/g, ' '); // code blocks (JSON, logs) are never read
  text = text.replace(/`([^`]*)`/g, '$1');
  for (let pass = 0; pass < 3; pass++) text = text.replace(/\{[^{}]*\}/g, (block) => (/"[^"]*"\s*:/.test(block) ? ' ' : block)); // JSON-looking objects
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [label](url) -> label
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(UUID, ' ').replace(PROVIDER_IDS, ' ').replace(TOOL_NAMES, ' ');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // headings
  text = text.replace(/^\s*[-*•]\s+/gm, ''); // bullets
  text = text.replace(/^\s*\d+[.)]\s+/gm, ''); // numbered list markers
  text = text.replace(/[*~]+/g, ''); // bold, italic, strikethrough marks
  text = text.replace(/(^|\s)_+|_+(?=\s|$)/g, ' '); // _italic_ marks at word edges (an underscore inside a word is left alone)
  text = text.replace(/\|/g, ', '); // table cells
  text = text.replace(/\p{Extended_Pictographic}/gu, '');
  text = text.replace(/\bRs\.?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g, (_whole, amount: string) => (hindi ? `${amount} रुपये` : `${amount} rupees`));
  text = text.replace(/([^.!?।:;,\n])[ \t]*\n+[ \t]*/g, '$1. '); // a line break ends a sentence
  text = text.replace(/\s*\n+\s*/g, ' ');
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?।;:])/g, '$1').trim();
}

/** A full stop after one of these (or after a single capital, like an initial) does not end a sentence: "Dr. Rao", "St. John Rd.". */
const SENTENCE_END = /(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Rd|Rs|No|vs|etc|a\.m|p\.m|e\.g|i\.e)\.|\b\p{Lu}\.)(?<=[.!?।])\s+/u;

/** Short pieces, each ending at a sentence (or, failing that, a comma or a space), so no word is ever cut and none is too long to speak. */
export function chunkText(text: string, max = 200): string[] {
  const sentences = text.split(SENTENCE_END).filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      pieces.push(sentence);
      continue;
    }
    let rest = sentence;
    while (rest.length > max) {
      const window = rest.slice(0, max + 1);
      let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
      if (cut < max * 0.4) cut = window.lastIndexOf(' ');
      if (cut <= 0) cut = max; // one unbroken string longer than max: the only case a split is forced
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push(rest);
  }
  const packed: string[] = [];
  for (const piece of pieces) {
    const last = packed[packed.length - 1];
    if (last !== undefined && last.length + piece.length + 1 <= max && scriptOf(last) === scriptOf(piece)) packed[packed.length - 1] = `${last} ${piece}`;
    else packed.push(piece);
  }
  return packed.filter((piece) => /[\p{L}\p{N}]/u.test(piece));
}

export interface SpokenSegment {
  text: string;
  lang: string;
}

/** The pieces to speak, each with the locale to speak it in: Devanagari is read in Hindi, anything else in `latinLocale`. */
export function toSegments(reply: string, latinLocale: string): SpokenSegment[] {
  return chunkText(toSpeakable(reply)).map((text) => ({ text, lang: scriptOf(text) === 'hi' ? 'hi-IN' : latinLocale }));
}
