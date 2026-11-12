import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRecognition } from './fakes';
import { SpeechListener, type ListenerHandlers } from './listener';
import type { VoiceErrorKind } from './types';

function setup(options: { isEcho?: (text: string) => boolean; endOfTurnMs?: number } = {}) {
  const turns: string[] = [];
  const interims: string[] = [];
  const silences: string[] = [];
  const errors: { kind: VoiceErrorKind; message: string }[] = [];
  let clock = 1_000;
  const listener = new SpeechListener({
    createRecognition: () => new FakeRecognition(),
    endOfTurnMs: options.endOfTurnMs ?? 1000,
    now: () => clock,
    isEcho: options.isEcho ? (text) => options.isEcho!(text) : undefined,
  });
  const handlers: ListenerHandlers = {
    onInterim: (text) => interims.push(text),
    onTurn: (text) => turns.push(text),
    onSilence: (why) => silences.push(why),
    onError: (kind, message) => errors.push({ kind, message }),
  };
  listener.setHandlers(handlers);
  return { listener, turns, interims, silences, errors, tick: (ms: number) => (clock += ms) };
}

describe('SpeechListener', () => {
  beforeEach(() => {
    FakeRecognition.reset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('starts listening in the chosen locale, with interim results on, and stops when told', () => {
    const { listener } = setup();
    listener.start('hi-IN');
    const recognition = FakeRecognition.last;
    expect(recognition).toMatchObject({ lang: 'hi-IN', interimResults: true, continuous: false, started: true });
    expect(listener.listening).toBe(true);
    listener.stop();
    expect(recognition.aborted).toBe(true);
    expect(listener.listening).toBe(false);
  });

  it('turns one spoken sentence into exactly one turn, after the pause, and shows live text meanwhile', () => {
    const { listener, turns, interims } = setup();
    listener.start('en-IN');
    FakeRecognition.last.hear('show my', false);
    expect(interims.at(-1)).toBe('show my');
    FakeRecognition.last.hear('show my appointments', true);
    expect(turns).toEqual([]); // not yet: the person may still be talking
    vi.advanceTimersByTime(1000);
    expect(turns).toEqual(['show my appointments']);
    expect(listener.listening).toBe(false);
  });

  it('joins a sentence that has a pause in the middle into ONE turn, not two messages', () => {
    const { listener, turns, tick } = setup();
    listener.start('en-IN');
    const first = FakeRecognition.last;
    first.hear('I want to book an appointment', true);
    tick(900);
    first.end(); // the browser ends this recognition at the pause
    vi.advanceTimersByTime(400);
    const second = FakeRecognition.last;
    expect(second).not.toBe(first); // it kept listening for the rest
    second.hear('with a cardiologist tomorrow', true);
    second.end();
    vi.advanceTimersByTime(1000);
    expect(turns).toEqual(['I want to book an appointment with a cardiologist tomorrow']);
  });

  it('never sends the same result twice, even if the browser delivers it twice', () => {
    const { listener, turns } = setup();
    listener.start('en-IN');
    FakeRecognition.last.hear('cancel my next appointment', true);
    FakeRecognition.last.repeatLast();
    FakeRecognition.last.repeatLast();
    vi.advanceTimersByTime(1000);
    expect(turns).toEqual(['cancel my next appointment']);
  });

  it('does not send the same sentence again when it comes straight back (a restart replay)', () => {
    const { listener, turns, silences, tick } = setup();
    listener.start('en-IN');
    FakeRecognition.last.hear('show my appointments', true);
    vi.advanceTimersByTime(1000);
    tick(1000);
    listener.start('en-IN');
    FakeRecognition.last.hear('Show my appointments', true);
    vi.advanceTimersByTime(1000);
    expect(turns).toEqual(['show my appointments']);
    expect(silences).toEqual(['duplicate']);
  });

  it('reports silence when nothing was heard, and for filler or empty results; never a message', () => {
    const { listener, turns, silences } = setup();
    listener.start('en-IN');
    FakeRecognition.last.fail('no-speech');
    FakeRecognition.last.end();
    expect(silences).toEqual(['silence']);
    listener.start('en-IN');
    FakeRecognition.last.hear('   ', true);
    FakeRecognition.last.end();
    expect(silences).toEqual(['silence', 'silence']); // blank results count as nothing heard
    listener.start('en-IN');
    FakeRecognition.last.hear('um', true);
    FakeRecognition.last.end();
    vi.advanceTimersByTime(1000);
    expect(silences.at(-1)).toBe('empty');
    expect(turns).toEqual([]);
  });

  it('treats the assistant\'s own voice as silence, not as a message', () => {
    const { listener, turns, silences } = setup({ isEcho: (text) => text.includes('next appointment is') });
    listener.start('en-IN');
    FakeRecognition.last.hear('your next appointment is with Dr. Rao tomorrow', true);
    vi.advanceTimersByTime(1000);
    expect(turns).toEqual([]);
    expect(silences).toEqual(['echo']);
  });

  it('explains each way the browser can refuse, and releases the microphone', () => {
    const cases: [string, VoiceErrorKind][] = [
      ['not-allowed', 'permission'],
      ['service-not-allowed', 'permission'],
      ['audio-capture', 'microphone'],
      ['network', 'network'],
      ['language-not-supported', 'language'],
      ['something-new', 'unknown'],
    ];
    for (const [code, kind] of cases) {
      const { listener, errors } = setup();
      listener.start('en-IN');
      const recognition = FakeRecognition.last;
      recognition.fail(code);
      expect(errors).toHaveLength(1);
      expect(errors[0].kind).toBe(kind);
      expect(errors[0].message.length).toBeGreaterThan(20);
      expect(recognition.aborted).toBe(true);
      expect(listener.listening).toBe(false);
    }
  });

  it('reports an unsupported or unstartable recogniser instead of throwing', () => {
    const broken = new SpeechListener({
      createRecognition: () => {
        throw new Error('unsupported');
      },
    });
    const errors: VoiceErrorKind[] = [];
    broken.setHandlers({ onTurn: () => undefined, onSilence: () => undefined, onError: (kind) => errors.push(kind) });
    broken.start('en-IN');
    expect(errors).toEqual(['unsupported']);

    const { listener, errors: startErrors } = setup();
    const original = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = () => {
      throw new Error('InvalidStateError');
    };
    listener.start('en-IN');
    FakeRecognition.prototype.start = original;
    expect(startErrors[0].kind).toBe('unknown');
  });

  it('ignores everything a stopped recogniser still says (late results, errors and end events)', () => {
    const { listener, turns, silences, errors } = setup();
    listener.start('en-IN');
    const old = FakeRecognition.last;
    listener.stop();
    old.hear('late words after stop', true);
    old.fail('network');
    old.end();
    vi.advanceTimersByTime(5000);
    expect({ turns, silences, errors }).toEqual({ turns: [], silences: [], errors: [] });
    // A brand new listening window is not confused by the old recogniser either.
    listener.start('en-IN');
    FakeRecognition.last.hear('hello again', true);
    old.hear('stale hello', true);
    vi.advanceTimersByTime(1000);
    expect(turns).toEqual(['hello again']);
  });

  it('can be told "that is all" and then delivers what it has at once', () => {
    const { listener, turns } = setup();
    listener.start('en-IN');
    FakeRecognition.last.hear('show my appointments', false);
    listener.commitNow();
    expect(turns).toEqual(['show my appointments']);
  });

  it('does not start twice, and never loops if the browser ends instantly after something was heard', () => {
    const { listener } = setup();
    listener.start('en-IN');
    listener.start('en-IN');
    expect(FakeRecognition.instances).toHaveLength(1);
    FakeRecognition.last.hear('hello there', true);
    for (let i = 0; i < 5; i++) FakeRecognition.last.end(); // ends at once, five times, with no time passing
    expect(FakeRecognition.instances.length).toBeLessThanOrEqual(2);
  });
});
