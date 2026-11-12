/**
 * Stand-ins for the browser's speech APIs, used only by the tests. They behave like the awkward real thing: aborting a recogniser still
 * fires its error and end events, and cancelling speech fires an "interrupted" error, so the code under test has to ignore stale events.
 * No real microphone or speaker is involved anywhere in the automated tests.
 */
import type { RecognitionEventLike, RecognitionLike, RecognitionResultLike, SynthLike, UtteranceLike, VoiceLike } from './types';

export class FakeRecognition implements RecognitionLike {
  static instances: FakeRecognition[] = [];
  static reset(): void {
    FakeRecognition.instances = [];
  }
  static get last(): FakeRecognition {
    return FakeRecognition.instances[FakeRecognition.instances.length - 1];
  }

  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;
  throwOnStart = false;
  private results: RecognitionResultLike[] = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    if (this.throwOnStart) throw new Error('InvalidStateError');
    this.started = true;
    this.onstart?.();
  }
  stop(): void {
    this.onend?.();
  }
  abort(): void {
    this.aborted = true;
    this.onerror?.({ error: 'aborted' });
    this.onend?.();
  }

  /** The recogniser hears something. `final` marks the end of that phrase. */
  hear(text: string, final = true): void {
    const result = Object.assign([{ transcript: text }], { isFinal: final }) as unknown as RecognitionResultLike;
    const index = this.results.length;
    this.results.push(result);
    this.onresult?.({ resultIndex: index, results: this.results });
    if (!final) this.results.pop(); // an interim result is replaced by the next one
  }
  /** Repeats the SAME final result (some browsers deliver a result twice). */
  repeatLast(): void {
    this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
  }
  fail(error: string): void {
    this.onerror?.({ error });
  }
  end(): void {
    this.onend?.();
  }
}

export class FakeUtterance implements UtteranceLike {
  lang = '';
  voice: VoiceLike | null = null;
  rate = 1;
  pitch = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  constructor(public text: string) {}
}

export class FakeSynth implements SynthLike {
  voices: VoiceLike[] = [];
  spoken: FakeUtterance[] = [];
  current: FakeUtterance | null = null;
  overlaps = 0;
  paused = false;
  cancels = 0;

  speak(utterance: UtteranceLike): void {
    if (this.current) this.overlaps++; // two things being spoken at once would be a bug
    this.current = utterance as FakeUtterance;
    this.spoken.push(this.current);
    utterance.onstart?.();
  }
  cancel(): void {
    this.cancels++;
    const interrupted = this.current;
    this.current = null;
    this.paused = false;
    interrupted?.onerror?.({ error: 'interrupted' });
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  getVoices(): VoiceLike[] {
    return this.voices;
  }
  /** The piece being spoken finishes. */
  finish(): void {
    const done = this.current;
    this.current = null;
    done?.onend?.();
  }
  /** Everything queued finishes, one piece after another. */
  finishAll(): void {
    while (this.current) this.finish();
  }
  get texts(): string[] {
    return this.spoken.map((utterance) => utterance.text);
  }
}

/** A microphone that counts how many tracks were opened and stopped. */
export function fakeMic(options: { fail?: { name: string } } = {}) {
  const state = { opened: 0, stopped: 0 };
  return {
    state,
    acquire: async () => {
      if (options.fail) throw Object.assign(new Error('mic'), options.fail);
      state.opened++;
      state.stopped++; // the real adapter stops the tracks straight away; the test checks that nothing is left open
    },
  };
}
