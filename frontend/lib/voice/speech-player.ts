import { toSegments, type SpokenSegment } from './speech-text';
import type { SynthLike, UtteranceLike, VoiceLike } from './types';

export type PlayerState = 'idle' | 'speaking' | 'paused';
/** How a spoken reply ended. */
export type SpeechOutcome = 'finished' | 'stopped' | 'error' | 'nothing';

export interface PlayerHandlers {
  onState?: (state: PlayerState, id: string | null) => void;
  /** Something the person should know, such as there being no voice for their language. */
  onNotice?: (message: string) => void;
}

export interface PlayerOptions {
  synth: SynthLike;
  createUtterance: (text: string) => UtteranceLike;
  now?: () => number;
}

/** The best installed voice for a locale: an exact match, else the same language (hi for hi-IN), else none (the browser picks by `lang`). */
export function pickVoice(voices: VoiceLike[], lang: string): VoiceLike | null {
  const wanted = lang.toLowerCase();
  const language = wanted.split('-')[0];
  const exact = voices.filter((voice) => voice.lang.toLowerCase().replace('_', '-') === wanted);
  const same = voices.filter((voice) => voice.lang.toLowerCase().replace('_', '-').split('-')[0] === language);
  const best = (list: VoiceLike[]) => list.find((voice) => voice.localService) ?? list[0] ?? null; // a voice that works offline first
  return best(exact) ?? best(same);
}

/**
 * Speaks assistant replies, one at a time. A reply is cleaned (no markdown, ids or JSON), cut into short pieces and spoken piece by piece
 * so nothing is cut off mid-word; each piece is spoken with a voice for its own language. Starting a new reply first cancels the
 * old one, so two voices never overlap, and a late "ended" event from a cancelled piece is ignored. The written reply is not touched.
 */
export class SpeechPlayer {
  private handlers: PlayerHandlers = {};
  private state: PlayerState = 'idle';
  private id: string | null = null;
  private generation = 0;
  private queue: SpokenSegment[] = [];
  private resolve: ((outcome: SpeechOutcome) => void) | null = null;
  private warned = new Set<string>();
  private spoken: { text: string; at: number }[] = [];
  private readonly now: () => number;

  constructor(private readonly options: PlayerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  setHandlers(handlers: PlayerHandlers): void {
    this.handlers = handlers;
  }

  get current(): { state: PlayerState; id: string | null } {
    return { state: this.state, id: this.id };
  }

  /** What was spoken in the last few seconds, so the listener can recognise its own echo. */
  recentSpoken(): { text: string; at: number }[] {
    return this.spoken;
  }

  /** Speaks a reply. Resolves when it ends: finished, stopped by someone, failed, or had nothing speakable. */
  speak(reply: string, options: { id?: string; latinLocale?: string } = {}): Promise<SpeechOutcome> {
    this.cancel('stopped');
    const segments = toSegments(reply, options.latinLocale ?? 'en-IN');
    if (segments.length === 0) return Promise.resolve('nothing');
    this.queue = segments;
    this.id = options.id ?? null;
    this.setState('speaking');
    const generation = this.generation;
    return new Promise<SpeechOutcome>((resolve) => {
      this.resolve = resolve;
      this.next(generation);
    });
  }

  pause(): void {
    if (this.state !== 'speaking') return;
    this.options.synth.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.options.synth.resume();
    this.setState('speaking');
  }

  /** Stops at once and discards the rest. */
  stop(): void {
    this.cancel('stopped');
  }

  dispose(): void {
    this.cancel('stopped');
  }

  private next(generation: number): void {
    if (generation !== this.generation) return;
    const segment = this.queue.shift();
    if (!segment) return this.finish('finished');
    const utterance = this.options.createUtterance(segment.text);
    utterance.lang = segment.lang;
    const voice = pickVoice(this.options.synth.getVoices(), segment.lang);
    if (voice) utterance.voice = voice;
    else if (!this.warned.has(segment.lang)) {
      this.warned.add(segment.lang);
      this.handlers.onNotice?.(segment.lang.startsWith('hi') ? 'No Hindi voice is installed in this browser, so the reply is read with the default voice. The written reply is unchanged.' : 'No matching voice was found, so the default voice is used.');
    }
    utterance.onstart = () => {
      if (generation === this.generation) this.spoken = [...this.spoken.filter((entry) => this.now() - entry.at < 15_000), { text: segment.text, at: this.now() }];
    };
    utterance.onend = () => {
      if (generation === this.generation) this.next(generation);
    };
    utterance.onerror = (event) => {
      if (generation !== this.generation) return;
      if (event.error === 'interrupted' || event.error === 'canceled') return; // our own cancel; the new state is already set
      this.handlers.onNotice?.('The reply could not be read aloud. The written reply is still there.');
      this.finish('error');
    };
    this.options.synth.speak(utterance);
  }

  private finish(outcome: SpeechOutcome): void {
    this.generation++;
    this.queue = [];
    this.resolveWith(outcome);
    this.setState('idle');
  }

  private cancel(outcome: SpeechOutcome): void {
    const active = this.state !== 'idle' || this.resolve !== null;
    this.generation++;
    this.queue = [];
    if (active) {
      this.options.synth.cancel();
      this.resolveWith(outcome);
      this.setState('idle');
    }
  }

  private resolveWith(outcome: SpeechOutcome): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(outcome);
  }

  private setState(state: PlayerState): void {
    this.state = state;
    if (state === 'idle') this.id = null;
    this.handlers.onState?.(state, this.id);
  }
}
