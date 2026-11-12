import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRecognition, FakeSynth, FakeUtterance, fakeMic } from './fakes';
import { SpeechListener } from './listener';
import { SpeechPlayer } from './speech-player';
import { VoiceSession, echoCheckFor, type VoiceState, type VoiceSubmit } from './voice-session';
import type { VoiceErrorKind } from './types';

/** Lets pending promises (the microphone permission, a chat answer) settle without moving the fake clock. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function setup(options: { micFail?: { name: string }; speakReplies?: boolean; maxSilentTurns?: number; maxSessionMs?: number } = {}) {
  FakeRecognition.reset();
  const synth = new FakeSynth();
  synth.voices = [{ name: 'English India', lang: 'en-IN', localService: true }];
  let clock = 1_000_000;
  const player = new SpeechPlayer({ synth, createUtterance: (text) => new FakeUtterance(text), now: () => clock });
  const listener = new SpeechListener({ createRecognition: () => new FakeRecognition(), endOfTurnMs: 1000, now: () => clock, isEcho: echoCheckFor(player) });
  const mic = fakeMic({ fail: options.micFail });
  const states: VoiceState[] = [];
  const sent: string[] = [];
  const notices: string[] = [];
  const errors: { kind: VoiceErrorKind; message: string }[] = [];
  const ended: string[] = [];
  const interims: string[] = [];
  const control = { speak: options.speakReplies ?? true, answer: (async () => ({ reply: 'You have one appointment tomorrow.' })) as (text: string) => Promise<VoiceSubmit> };
  const session = new VoiceSession({
    listener,
    player,
    acquireMic: mic.acquire,
    submit: async (text) => {
      sent.push(text);
      return control.answer(text);
    },
    speakReplies: () => control.speak,
    recognitionLocale: () => 'en-IN',
    latinSpeechLocale: () => 'en-IN',
    onState: (state) => states.push(state),
    onInterim: (text) => interims.push(text),
    onNotice: (message) => notices.push(message),
    onError: (kind, message) => errors.push({ kind, message }),
    onEnded: (why) => ended.push(why),
    now: () => clock,
    resumeDelayMs: 450,
    maxSilentTurns: options.maxSilentTurns ?? 3,
    maxSessionMs: options.maxSessionMs,
  });
  /** The person says something and the pause that ends the turn passes. */
  const say = async (text: string) => {
    FakeRecognition.last.hear(text, true);
    vi.advanceTimersByTime(1000);
    await settle();
  };
  return { session, synth, player, listener, mic, states, sent, notices, errors, ended, interims, control, say, tick: (ms: number) => (clock += ms) };
}

describe('VoiceSession: a hands-free conversation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('goes listening -> processing -> speaking -> listening, one message per spoken turn', async () => {
    const t = setup();
    await t.session.start();
    expect(t.states).toEqual(['starting', 'listening']);
    expect(t.mic.state).toEqual({ opened: 1, stopped: 1 }); // asked once, nothing left open
    expect(FakeRecognition.last.started).toBe(true);

    await t.say('mere upcoming appointments dikhao');
    expect(t.sent).toEqual(['mere upcoming appointments dikhao']);
    expect(t.states).toEqual(['starting', 'listening', 'processing', 'speaking']);
    expect(t.synth.texts).toEqual(['You have one appointment tomorrow.']);
    expect(FakeRecognition.instances.every((recognition) => recognition.aborted || recognition === FakeRecognition.instances[0])).toBe(true);

    t.synth.finishAll();
    await settle();
    expect(t.states.at(-1)).toBe('speaking'); // not listening yet: a short pause first, so the last syllable cannot be heard
    const heardBefore = FakeRecognition.instances.length;
    vi.advanceTimersByTime(300);
    expect(FakeRecognition.instances.length).toBe(heardBefore); // still not listening: the pause has not passed
    vi.advanceTimersByTime(150);
    expect(t.states.at(-1)).toBe('listening');
    expect(FakeRecognition.instances.length).toBe(heardBefore + 1);

    await t.say('book a cardiologist tomorrow');
    expect(t.sent).toEqual(['mere upcoming appointments dikhao', 'book a cardiologist tomorrow']);
    t.session.stop();
    expect(t.states.at(-1)).toBe('idle');
    expect(t.ended).toEqual(['user']);
  });

  it('keeps the microphone OFF while the assistant speaks, so it cannot hear itself', async () => {
    const t = setup();
    await t.session.start();
    await t.say('show my appointments');
    expect(t.states.at(-1)).toBe('speaking');
    const live = FakeRecognition.instances.filter((recognition) => recognition.started && !recognition.aborted);
    expect(live).toHaveLength(0); // no recogniser is running while the reply plays
    expect(t.listener.listening).toBe(false);
    // Anything a stray recogniser still reports during the speech goes nowhere.
    FakeRecognition.instances[0].hear('you have one appointment tomorrow', true);
    vi.advanceTimersByTime(2000);
    await settle();
    expect(t.sent).toEqual(['show my appointments']);
  });

  it('drops the assistant\'s own words if they are heard right after it stops, and just listens again', async () => {
    const t = setup();
    await t.session.start();
    await t.say('what are my appointments');
    t.synth.finishAll();
    await settle();
    vi.advanceTimersByTime(450);
    await t.say('you have one appointment tomorrow at nine thirty with doctor rao');
    // 'You have one appointment tomorrow.' was just spoken: the heard phrase starts with it, but is longer and different, so it is a person.
    expect(t.sent).toHaveLength(2);

    const t2 = setup();
    t2.control.answer = async () => ({ reply: 'Your next appointment is with Dr. Rao tomorrow at 9:30 AM in the morning.' });
    await t2.session.start();
    await t2.say('what is next');
    t2.synth.finishAll();
    await settle();
    vi.advanceTimersByTime(450);
    await t2.say('your next appointment is with Dr. Rao tomorrow at 9:30 AM in the morning'); // the speakers coming back
    vi.advanceTimersByTime(500);
    expect(t2.sent).toEqual(['what is next']); // not submitted as a message
    expect(t2.states.at(-1)).toBe('listening'); // and it is listening again for the real person
  });

  it('lets the person interrupt: speech stops at once and listening begins', async () => {
    const t = setup();
    t.control.answer = async () => ({ reply: 'First sentence of a long reply that goes on and on for a while yet. Second sentence of that reply is also quite long indeed. Third.' });
    await t.session.start();
    await t.say('tell me everything');
    expect(t.states.at(-1)).toBe('speaking');
    t.session.interrupt();
    await settle();
    expect(t.synth.current).toBeNull();
    vi.advanceTimersByTime(450);
    expect(t.states.at(-1)).toBe('listening');
    expect(t.synth.texts.length).toBeLessThanOrEqual(2); // the rest of the reply was never spoken
    t.synth.finishAll();
    expect(t.synth.overlaps).toBe(0);
  });

  it('stops everything when the person ends voice mode, during any stage', async () => {
    // while listening
    let t = setup();
    await t.session.start();
    t.session.stop();
    expect(FakeRecognition.last.aborted).toBe(true);
    expect(t.listener.listening).toBe(false);

    // while processing: the answer arrives later and is NOT spoken or listened to
    t = setup();
    let release: (value: VoiceSubmit) => void = () => undefined;
    t.control.answer = () => new Promise<VoiceSubmit>((resolve) => (release = resolve));
    await t.session.start();
    await t.say('show my appointments');
    expect(t.states.at(-1)).toBe('processing');
    t.session.stop();
    release({ reply: 'Too late to be spoken.' });
    await settle();
    vi.advanceTimersByTime(5000);
    expect(t.synth.spoken).toEqual([]);
    expect(FakeRecognition.instances.filter((recognition) => recognition.started && !recognition.aborted)).toEqual([]);
    expect(t.states.at(-1)).toBe('idle');

    // while speaking
    t = setup();
    await t.session.start();
    await t.say('show my appointments');
    t.session.stop();
    expect(t.synth.current).toBeNull();
    t.synth.finishAll();
    await settle();
    vi.advanceTimersByTime(5000);
    expect(t.states.at(-1)).toBe('idle');
    expect(FakeRecognition.instances.filter((recognition) => recognition.started && !recognition.aborted)).toEqual([]);
  });

  it('stops while the microphone permission prompt is still open', async () => {
    const t = setup();
    const start = t.session.start();
    t.session.stop();
    await start;
    await settle();
    expect(FakeRecognition.instances).toHaveLength(0); // it never began listening
    expect(t.states.at(-1)).toBe('idle');
  });

  it('explains a blocked or missing microphone and ends without listening', async () => {
    for (const [name, kind] of [['NotAllowedError', 'permission'], ['NotFoundError', 'microphone'], ['NotReadableError', 'microphone'], ['SomethingElse', 'unknown']] as const) {
      const t = setup({ micFail: { name } });
      await t.session.start();
      expect(t.errors).toHaveLength(1);
      expect(t.errors[0].kind).toBe(kind);
      expect(t.states.at(-1)).toBe('idle');
      expect(t.ended).toEqual(['error']);
      expect(FakeRecognition.instances).toHaveLength(0);
    }
  });

  it('ends by itself after a few turns of silence, and keeps listening in between (it is not an endless loop)', async () => {
    const t = setup({ maxSilentTurns: 3 });
    await t.session.start();
    for (let i = 0; i < 2; i++) {
      FakeRecognition.last.fail('no-speech');
      FakeRecognition.last.end();
      vi.advanceTimersByTime(200);
      expect(t.states.at(-1)).toBe('listening');
    }
    FakeRecognition.last.fail('no-speech');
    FakeRecognition.last.end();
    expect(t.states.at(-1)).toBe('idle');
    expect(t.ended).toEqual(['idle']);
    expect(t.notices.at(-1)).toMatch(/didn't hear anything/);
    expect(t.sent).toEqual([]); // silence never became a message
    const count = FakeRecognition.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeRecognition.instances.length).toBe(count); // and nothing starts listening again by itself
  });

  it('ends by itself after the time limit', async () => {
    const t = setup({ maxSessionMs: 60_000 });
    await t.session.start();
    t.tick(61_000);
    await t.say('show my appointments');
    t.synth.finishAll();
    await settle();
    vi.advanceTimersByTime(450);
    expect(t.states.at(-1)).toBe('idle');
    expect(t.ended).toEqual(['timeout']);
  });

  it('survives a failed answer, and gives up after two in a row', async () => {
    const t = setup();
    t.control.answer = async () => ({ error: 'The assistant is temporarily unavailable. Please try again in a moment.' });
    await t.session.start();
    await t.say('show my appointments');
    expect(t.notices.at(-1)).toMatch(/temporarily unavailable/);
    vi.advanceTimersByTime(450);
    expect(t.states.at(-1)).toBe('listening');
    await t.say('show my doctors');
    expect(t.states.at(-1)).toBe('idle');
    expect(t.ended).toEqual(['errors']);

    const recovering = setup();
    let n = 0;
    recovering.control.answer = async () => (n++ === 0 ? { error: 'One failure.' } : { reply: 'Back to normal.' });
    await recovering.session.start();
    await recovering.say('first');
    vi.advanceTimersByTime(450);
    await recovering.say('second');
    expect(recovering.synth.texts).toEqual(['Back to normal.']);
    expect(recovering.states.at(-1)).toBe('speaking');
  });

  it('waits when the assistant is still busy with a typed message, instead of sending twice', async () => {
    const t = setup();
    t.control.answer = async () => ({ busy: true });
    await t.session.start();
    await t.say('show my appointments');
    expect(t.notices.at(-1)).toMatch(/Still working/);
    vi.advanceTimersByTime(450);
    expect(t.states.at(-1)).toBe('listening');
    expect(t.ended).toEqual([]);
  });

  it('keeps listening without speaking when spoken replies are switched off', async () => {
    const t = setup({ speakReplies: false });
    await t.session.start();
    await t.say('show my appointments');
    expect(t.synth.spoken).toEqual([]);
    vi.advanceTimersByTime(450);
    expect(t.states.at(-1)).toBe('listening');
  });

  it('ends cleanly when the browser refuses recognition mid-session', async () => {
    const t = setup();
    await t.session.start();
    FakeRecognition.last.fail('network');
    expect(t.errors[0].kind).toBe('network');
    expect(t.states.at(-1)).toBe('idle');
    expect(t.ended).toEqual(['error']);
  });

  it('does nothing if started twice, or stopped when not running', async () => {
    const t = setup();
    await t.session.start();
    await t.session.start();
    expect(t.states).toEqual(['starting', 'listening']);
    t.session.stop();
    t.session.stop();
    expect(t.ended).toEqual(['user']);
  });
});
