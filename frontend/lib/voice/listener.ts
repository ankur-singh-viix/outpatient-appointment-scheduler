import type { RecognitionEventLike, RecognitionLike, VoiceErrorKind } from './types';
import { DuplicateGuard, cleanTranscript, isMeaningful } from './transcript';

export interface ListenerHandlers {
  /** Live text while the person is still speaking (shown, never sent). */
  onInterim?: (text: string) => void;
  /** One finished utterance, once: the speaker paused long enough that they are done. */
  onTurn: (text: string) => void;
  /** The window ended with nothing worth sending: nothing heard, only noise, a repeat, or the assistant's own voice. */
  onSilence: (why: 'silence' | 'empty' | 'duplicate' | 'echo') => void;
  onError: (kind: VoiceErrorKind, message: string) => void;
}

export interface ListenerOptions {
  createRecognition: () => RecognitionLike;
  /** How long a pause means the person has finished (several browser results are joined into one message until then). */
  endOfTurnMs?: number;
  now?: () => number;
  /** True when the text is the assistant's own voice. */
  isEcho?: (text: string, now: number) => boolean;
}

const ERROR_TEXT: Record<string, { kind: VoiceErrorKind; message: string }> = {
  'not-allowed': { kind: 'permission', message: 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.' },
  'service-not-allowed': { kind: 'permission', message: 'The browser would not start speech recognition here. Allow the microphone for this site in your browser settings, then try again.' },
  'audio-capture': { kind: 'microphone', message: 'No microphone was found, or another app is using it.' },
  network: { kind: 'network', message: "The browser's speech service could not be reached. Check your connection and try again." },
  'language-not-supported': { kind: 'language', message: 'This browser cannot recognise that language. Choose another language, or type instead.' },
};

/** A restart that ends faster than this is not retried, so a browser that ends instantly cannot make a loop. */
const MIN_RESTART_GAP_MS = 250;

/**
 * Listens for ONE spoken turn. It wraps the browser's SpeechRecognition so that:
 *  - several results that belong to one sentence (a pause in the middle) are joined into one turn, not sent as pieces;
 *  - the same text delivered twice is sent once;
 *  - late callbacks from a recogniser that was stopped (or replaced) are ignored;
 *  - silence, noise and the assistant's own voice are reported as silence, never as a message;
 *  - the microphone is released (abort) whenever it stops, whatever the reason.
 * It never sends anything itself; it hands finished turns to its owner.
 */
export class SpeechListener {
  private handlers: ListenerHandlers = { onTurn: () => undefined, onSilence: () => undefined, onError: () => undefined };
  private active = false;
  private generation = 0;
  private recognition: RecognitionLike | null = null;
  private finals: string[] = [];
  private seen = new Set<string>();
  private interim = '';
  private heard = false;
  private lang = 'en-IN';
  private openedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly guard = new DuplicateGuard();
  private readonly endOfTurnMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ListenerOptions) {
    this.endOfTurnMs = options.endOfTurnMs ?? 1400;
    this.now = options.now ?? (() => Date.now());
  }

  setHandlers(handlers: ListenerHandlers): void {
    this.handlers = handlers;
  }

  get listening(): boolean {
    return this.active;
  }

  start(lang: string): void {
    if (this.active) return;
    this.active = true;
    this.lang = lang;
    this.finals = [];
    this.seen = new Set();
    this.interim = '';
    this.heard = false;
    this.open();
  }

  /** Stops listening and drops whatever was heard. Nothing is delivered. */
  stop(): void {
    this.release();
    this.reset();
  }

  /** Finishes the turn now with what has been heard so far (the person pressed "done"). */
  commitNow(): void {
    if (this.active) this.commit();
  }

  private open(): void {
    const generation = ++this.generation;
    let recognition: RecognitionLike;
    try {
      recognition = this.options.createRecognition();
    } catch {
      this.fail('unsupported', 'Voice input is not available in this browser.');
      return;
    }
    recognition.lang = this.lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // Every callback first checks that it belongs to the CURRENT recogniser of an ACTIVE listener, so stale events do nothing.
    recognition.onresult = (event) => {
      if (generation === this.generation && this.active) this.onResult(event, generation);
    };
    recognition.onerror = (event) => {
      if (generation === this.generation && this.active) this.onError(event.error);
    };
    recognition.onend = () => {
      if (generation === this.generation && this.active) this.onEnd();
    };
    this.recognition = recognition;
    this.openedAt = this.now();
    try {
      recognition.start();
    } catch {
      this.fail('unknown', 'Could not start listening. Please try again.');
    }
  }

  private onResult(event: RecognitionEventLike, generation: number): void {
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      const text = cleanTranscript(result[0]?.transcript ?? '');
      if (result.isFinal) {
        const key = `${generation}:${index}`;
        if (text && !this.seen.has(key)) {
          this.seen.add(key);
          this.finals.push(text);
        }
        this.interim = '';
      } else {
        this.interim = text;
      }
      if (text) this.heard = true;
    }
    this.handlers.onInterim?.(cleanTranscript([...this.finals, this.interim].join(' ')));
    if (this.heard) this.armTimer();
  }

  private onError(code: string): void {
    if (code === 'no-speech' || code === 'aborted') return; // the end event follows and decides
    const known = ERROR_TEXT[code];
    this.fail(known?.kind ?? 'unknown', known?.message ?? 'Speech recognition stopped unexpectedly. Please try again.');
  }

  private onEnd(): void {
    this.recognition = null;
    if (!this.heard) {
      this.release();
      this.reset();
      this.handlers.onSilence('silence');
      return;
    }
    // Something was heard but the person may still be mid-sentence: keep listening until they have paused for the whole interval.
    if (!this.timer) this.armTimer();
    if (this.now() - this.openedAt >= MIN_RESTART_GAP_MS) this.open();
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.active) this.commit();
    }, this.endOfTurnMs);
  }

  private commit(): void {
    const text = cleanTranscript(this.finals.length > 0 ? this.finals.join(' ') : this.interim);
    this.release();
    this.reset();
    if (!isMeaningful(text)) return void this.handlers.onSilence('empty');
    const at = this.now();
    if (this.options.isEcho?.(text, at)) return void this.handlers.onSilence('echo');
    if (!this.guard.accept(text, at)) return void this.handlers.onSilence('duplicate');
    this.handlers.onTurn(text);
  }

  private fail(kind: VoiceErrorKind, message: string): void {
    this.release();
    this.reset();
    this.handlers.onError(kind, message);
  }

  /** Lets go of the browser's recogniser and ignores anything it still says. */
  private release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    const recognition = this.recognition;
    this.recognition = null;
    this.active = false;
    if (recognition) {
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    }
  }

  private reset(): void {
    this.finals = [];
    this.seen = new Set();
    this.interim = '';
    this.heard = false;
  }
}
