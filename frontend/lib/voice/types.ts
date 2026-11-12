/**
 * The small slices of the browser's speech APIs the assistant uses, written as interfaces so the logic around them can be tested with
 * fakes and so every browser difference lives in one place (browser.ts). Nothing here records, stores or uploads audio: recognition and
 * synthesis are done by the browser itself.
 */

export interface RecognitionAlternativeLike {
  transcript: string;
  confidence?: number;
}
export interface RecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternativeLike;
}
export interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
export interface RecognitionErrorLike {
  error: string;
}

/** A SpeechRecognition object. */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

/** A SpeechSynthesisUtterance. */
export interface UtteranceLike {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  rate: number;
  pitch: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

/** speechSynthesis. */
export interface SynthLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): VoiceLike[];
}

/** Why voice stopped working, in terms the interface can explain. */
export type VoiceErrorKind = 'unsupported' | 'insecure' | 'permission' | 'microphone' | 'network' | 'language' | 'unknown';

/** What the person chose to speak in. "hinglish" is Hindi and English mixed; browsers have no such locale, so it listens as Hindi (see languages.ts). */
export type VoiceLanguage = 'en' | 'hi' | 'hinglish';
