import type { VoiceLanguage } from './types';

export interface LanguageChoice {
  value: VoiceLanguage;
  label: string;
  /** The locale the browser listens in. */
  recognition: string;
  /** The locale spoken replies default to when the text itself does not say (Latin letters). */
  speech: string;
}

/**
 * Browsers recognise one locale at a time and have no "Hinglish" locale. Hindi (hi-IN) copes best with Hindi and English mixed in one
 * sentence (it writes the Hindi words in Devanagari and keeps English words), so Hinglish listens as hi-IN. English is Indian English
 * (en-IN). What is spoken BACK is chosen from the reply's own letters (see speech-text.ts), not from this choice.
 */
export const LANGUAGES: LanguageChoice[] = [
  { value: 'en', label: 'English', recognition: 'en-IN', speech: 'en-IN' },
  { value: 'hi', label: 'हिन्दी (Hindi)', recognition: 'hi-IN', speech: 'hi-IN' },
  { value: 'hinglish', label: 'Hinglish', recognition: 'hi-IN', speech: 'en-IN' },
];

export const languageChoice = (value: VoiceLanguage): LanguageChoice => LANGUAGES.find((choice) => choice.value === value) ?? LANGUAGES[0];
