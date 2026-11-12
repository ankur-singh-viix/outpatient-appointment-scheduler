import type { SpeechListener } from './listener';
import type { SpeechOutcome } from './speech-player';
import type { VoiceErrorKind } from './types';
import { looksLikeEcho } from './transcript';

/** What the session needs from the thing that speaks (SpeechPlayer, or nothing at all in a browser with no speech synthesis). */
export interface Speaker {
  speak(text: string, options?: { id?: string; latinLocale?: string }): Promise<SpeechOutcome>;
  stop(): void;
  recentSpoken(): { text: string; at: number }[];
}

export type VoiceState = 'idle' | 'starting' | 'listening' | 'processing' | 'speaking';

/** What sending a spoken message to the assistant produced. The session only speaks `reply`; it never decides anything about it. */
export type VoiceSubmit = { reply: string } | { error: string } | { busy: true };

export interface VoiceSessionDeps {
  listener: SpeechListener;
  player: Speaker;
  /** Asks permission once, up front, so a denied or missing microphone is reported clearly. Resolves when the microphone is usable. */
  acquireMic: () => Promise<void>;
  /** Sends the text through the existing assistant chat and returns its answer. */
  submit: (text: string) => Promise<VoiceSubmit>;
  speakReplies: () => boolean;
  recognitionLocale: () => string;
  latinSpeechLocale: () => string;
  onState: (state: VoiceState) => void;
  onInterim: (text: string) => void;
  onNotice: (message: string) => void;
  onError: (kind: VoiceErrorKind, message: string) => void;
  /** Why the session ended, whenever it does (including by itself). */
  onEnded: (why: 'user' | 'idle' | 'errors' | 'timeout' | 'error') => void;
  now?: () => number;
  /** How long after the assistant stops speaking before listening resumes, so its last syllable cannot be heard as speech. */
  resumeDelayMs?: number;
  /** Consecutive turns with nothing said before the session ends by itself. */
  maxSilentTurns?: number;
  maxSessionMs?: number;
}

const ERROR_NAMES: Record<string, VoiceErrorKind> = {
  NotAllowedError: 'permission',
  SecurityError: 'permission',
  PermissionDeniedError: 'permission',
  NotFoundError: 'microphone',
  DevicesNotFoundError: 'microphone',
  NotReadableError: 'microphone',
  OverconstrainedError: 'microphone',
  AbortError: 'microphone',
};

const MESSAGES: Record<VoiceErrorKind, string> = {
  permission: 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then start voice mode again.',
  microphone: 'No microphone was found, or another app is using it.',
  insecure: 'Voice needs a secure (https) page.',
  unsupported: 'Voice input is not supported in this browser. Chrome or Edge works best; you can still type.',
  network: "The browser's speech service could not be reached. Check your connection.",
  language: 'This browser cannot recognise that language. Choose another, or type instead.',
  unknown: 'Voice stopped unexpectedly. You can start it again, or type.',
};

/** What went wrong asking for the microphone, in words for the person. */
export function describeMicError(error: unknown): { kind: VoiceErrorKind; message: string } {
  const kind = ERROR_NAMES[(error as { name?: string })?.name ?? ''] ?? 'unknown';
  return { kind, message: MESSAGES[kind] };
}

/**
 * A hands-free conversation, one turn at a time and strictly HALF-DUPLEX:
 *
 *   listening  -> (a finished sentence)  -> processing -> speaking -> (a short pause) -> listening -> ...
 *
 * The microphone is OFF while the assistant speaks and while it is thinking, so the assistant cannot hear itself. Browsers cannot give
 * a web page reliable echo cancellation for speech recognition, so this is the dependable design rather than a pretence of full-duplex.
 * A person interrupts by pressing Stop speaking, which ends the speech and starts listening at once.
 *
 * It is bounded, never a loop that runs unattended: it ends by itself after a few silent turns, after repeated failures, or after a time
 * limit, and ends the moment the owner calls stop(). Every asynchronous step checks that the session it belongs to is still the current
 * one, so a late answer or a late recogniser can never speak or listen after the session has ended.
 */
export class VoiceSession {
  private state: VoiceState = 'idle';
  private run = 0;
  private silentTurns = 0;
  private failures = 0;
  private startedAt = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: VoiceSessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    deps.listener.setHandlers({
      onInterim: (text) => deps.onInterim(text),
      onTurn: (text) => void this.turn(text),
      onSilence: (why) => this.silence(why),
      onError: (kind, message) => this.fail(kind, message),
    });
  }

  get current(): VoiceState {
    return this.state;
  }

  /** Starts voice mode (an explicit action by the person). */
  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    const run = ++this.run;
    this.silentTurns = 0;
    this.failures = 0;
    this.startedAt = this.now();
    this.set('starting');
    try {
      await this.deps.acquireMic();
    } catch (error) {
      if (run !== this.run) return; // stopped while the permission prompt was open
      const problem = describeMicError(error);
      this.fail(problem.kind, problem.message);
      return;
    }
    if (run !== this.run) return;
    this.listen(run);
  }

  /** Ends voice mode: microphone off, speech stopped, nothing more will be sent or spoken. */
  stop(why: 'user' | 'idle' | 'errors' | 'timeout' | 'error' = 'user'): void {
    if (this.state === 'idle') return;
    this.run++;
    this.clearResume();
    this.deps.listener.stop();
    this.deps.player.stop();
    this.set('idle');
    this.deps.onInterim('');
    this.deps.onEnded(why);
  }

  /** The person pressed "stop speaking" (or spoke over it): the speech ends now and the microphone comes back at once. */
  interrupt(): void {
    if (this.state !== 'speaking') return;
    this.deps.player.stop(); // its promise settles as 'stopped', which resumes listening below
  }

  private listen(run: number): void {
    if (run !== this.run) return;
    if (this.now() - this.startedAt > (this.deps.maxSessionMs ?? 15 * 60_000)) {
      this.deps.onNotice('Voice mode ended after a while to protect your privacy. Start it again to continue.');
      this.stop('timeout');
      return;
    }
    this.set('listening');
    this.deps.listener.start(this.deps.recognitionLocale());
  }

  private listenSoon(run: number, delay = this.deps.resumeDelayMs ?? 450): void {
    this.clearResume();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.listen(run);
    }, delay);
  }

  private silence(why: 'silence' | 'empty' | 'duplicate' | 'echo'): void {
    if (this.state !== 'listening') return;
    const run = this.run;
    if (why === 'echo' || why === 'duplicate') return this.listenSoon(run); // not the person's speech: just listen again
    this.silentTurns++;
    if (this.silentTurns >= (this.deps.maxSilentTurns ?? 3)) {
      this.deps.onNotice("I didn't hear anything, so voice mode has stopped. Press the microphone to start again.");
      this.stop('idle');
      return;
    }
    this.listenSoon(run, 150);
  }

  private async turn(text: string): Promise<void> {
    if (this.state !== 'listening') return;
    const run = this.run;
    this.silentTurns = 0;
    this.set('processing');
    let result: VoiceSubmit;
    try {
      result = await this.deps.submit(text);
    } catch {
      result = { error: 'That did not go through. Please try again.' };
    }
    if (run !== this.run) return; // voice mode was stopped meanwhile: the answer stays on screen but is not spoken
    if ('busy' in result) {
      this.deps.onNotice('Still working on your last message. Say it again in a moment.');
      return this.listenSoon(run);
    }
    if ('error' in result) {
      this.failures++;
      this.deps.onNotice(result.error);
      if (this.failures >= 2) {
        this.stop('errors');
        return;
      }
      return this.listenSoon(run);
    }
    this.failures = 0;
    if (!this.deps.speakReplies()) return this.listenSoon(run);
    this.set('speaking');
    const outcome = await this.deps.player.speak(result.reply, { id: 'voice', latinLocale: this.deps.latinSpeechLocale() });
    if (run !== this.run) return;
    if (outcome === 'error') this.deps.onNotice('The reply could not be read aloud. It is on screen.');
    this.listenSoon(run);
  }

  /** The browser said no (microphone blocked or missing, no network, ...). The session ends and says why. */
  private fail(kind: VoiceErrorKind, message: string): void {
    this.run++;
    this.clearResume();
    this.deps.listener.stop();
    this.deps.player.stop();
    this.set('idle');
    this.deps.onInterim('');
    this.deps.onError(kind, message);
    this.deps.onEnded('error');
  }

  private clearResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  private set(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.onState(state);
  }
}

/** Builds the echo check a listener uses: what was heard is mostly what the assistant itself just said. */
export const echoCheckFor = (player: Pick<Speaker, 'recentSpoken'>) => (text: string, now: number): boolean => looksLikeEcho(text, player.recentSpoken(), now);
