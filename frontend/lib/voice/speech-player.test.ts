import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSynth, FakeUtterance } from './fakes';
import { SpeechPlayer, pickVoice, type PlayerState } from './speech-player';
import type { VoiceLike } from './types';

const voices: VoiceLike[] = [
  { name: 'English US', lang: 'en-US', localService: true },
  { name: 'English India', lang: 'en-IN', localService: false },
  { name: 'English India local', lang: 'en_IN', localService: true },
  { name: 'Hindi', lang: 'hi-IN', localService: true },
];

function setup() {
  const synth = new FakeSynth();
  synth.voices = voices;
  const states: [PlayerState, string | null][] = [];
  const notices: string[] = [];
  let clock = 0;
  const player = new SpeechPlayer({ synth, createUtterance: (text) => new FakeUtterance(text), now: () => clock });
  player.setHandlers({ onState: (state, id) => states.push([state, id]), onNotice: (message) => notices.push(message) });
  return { synth, player, states, notices, tick: (ms: number) => (clock += ms) };
}

describe('pickVoice', () => {
  it('prefers an exact locale (a local one first), then the same language, else nothing', () => {
    expect(pickVoice(voices, 'en-IN')?.name).toBe('English India local');
    expect(pickVoice(voices, 'hi-IN')?.name).toBe('Hindi');
    expect(pickVoice(voices, 'en-GB')?.lang.startsWith('en')).toBe(true);
    expect(pickVoice(voices, 'ta-IN')).toBeNull();
    expect(pickVoice([], 'en-IN')).toBeNull();
  });
});

describe('SpeechPlayer', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('speaks a reply with a voice for its language and reports when it has finished', async () => {
    const { player, synth } = ctx;
    const done = player.speak('Your appointment is tomorrow.', { id: 'm1' });
    expect(synth.current?.text).toBe('Your appointment is tomorrow.');
    expect(synth.current?.lang).toBe('en-IN');
    expect(synth.current?.voice?.lang.replace('_', '-')).toBe('en-IN');
    expect(player.current).toEqual({ state: 'speaking', id: 'm1' });
    synth.finish();
    await expect(done).resolves.toBe('finished');
    expect(player.current).toEqual({ state: 'idle', id: null });
  });

  it('reads a long reply piece by piece, in order, one at a time, without overlap', async () => {
    const { player, synth } = ctx;
    const sentences = Array.from({ length: 6 }, (_, i) => `This is the sentence number ${i + 1} of the long reply and it keeps going for a while.`);
    const done = player.speak(sentences.join(' '));
    expect(synth.spoken).toHaveLength(1);
    let guard = 0;
    while (synth.current && guard++ < 50) synth.finish();
    await expect(done).resolves.toBe('finished');
    expect(synth.overlaps).toBe(0);
    expect(synth.texts.join(' ')).toBe(sentences.join(' '));
    expect(synth.texts.every((text) => text.length <= 200)).toBe(true);
  });

  it('speaks Hindi pieces with the Hindi voice and English pieces with the English one, and warns when a voice is missing', () => {
    const { player, synth } = ctx;
    void player.speak('आपका अपॉइंटमेंट कल है। Dr. Rao will see you at 9:30 AM.');
    expect(synth.current?.lang).toBe('hi-IN');
    expect(synth.current?.voice?.name).toBe('Hindi');
    synth.finish();
    expect(synth.current?.lang).toBe('en-IN');

    const bare = setup();
    bare.synth.voices = [];
    void bare.player.speak('आपका अपॉइंटमेंट कल है।');
    expect(bare.notices).toEqual([expect.stringMatching(/No Hindi voice/)]);
    expect(bare.synth.current?.lang).toBe('hi-IN'); // still spoken, by the browser's best guess
  });

  it('never speaks markdown, ids, JSON or tool names, and says nothing for a reply with nothing to say', async () => {
    const { player, synth } = ctx;
    void player.speak('**Done** — see get_my_appointments {"id":"5f1b2c9e-1234-4abc-9def-0123456789ab"} order_Abc12 https://x.test/y');
    expect(synth.current?.text).toBe('Done — see');
    synth.finish();
    await expect(player.speak('```json\n{"a":1}\n```')).resolves.toBe('nothing');
    expect(synth.current).toBeNull();
  });

  it('starting a new reply cancels the old one, and the old one can no longer move things along', async () => {
    const { player, synth } = ctx;
    const longSentence = (word: string) => Array.from({ length: 24 }, () => word).join(' ') + '.';
    const first = player.speak(`${longSentence('alpha')} ${longSentence('beta')}`);
    const stale = synth.current!;
    const second = player.speak('Second reply.');
    await expect(first).resolves.toBe('stopped');
    expect(synth.current?.text).toBe('Second reply.');
    stale.onend?.(); // a late "ended" from the cancelled speech must do nothing
    expect(synth.current?.text).toBe('Second reply.');
    expect(synth.spoken.map((utterance) => utterance.text)).toEqual([longSentence('alpha'), 'Second reply.']); // the first reply's second sentence never plays
    synth.finish();
    await expect(second).resolves.toBe('finished');
  });

  it('pauses, resumes and stops', async () => {
    const { player, synth } = ctx;
    const done = player.speak('A reply to interrupt.');
    player.pause();
    expect(synth.paused).toBe(true);
    expect(player.current.state).toBe('paused');
    player.pause(); // already paused: nothing happens
    player.resume();
    expect(synth.paused).toBe(false);
    expect(player.current.state).toBe('speaking');
    player.resume(); // not paused: nothing happens
    player.stop();
    await expect(done).resolves.toBe('stopped');
    expect(player.current.state).toBe('idle');
    expect(synth.cancels).toBeGreaterThan(0);
    player.stop(); // nothing playing: harmless
  });

  it('reports a failure to speak without hanging, and ignores the "interrupted" error of its own cancel', async () => {
    const { player, synth, notices } = ctx;
    const done = player.speak('This will fail.');
    synth.current!.onerror?.({ error: 'synthesis-failed' });
    await expect(done).resolves.toBe('error');
    expect(notices.at(-1)).toMatch(/could not be read aloud/);
    expect(player.current.state).toBe('idle');
    const again = player.speak('Now it works.');
    player.stop(); // fires the fake's "interrupted" error
    await expect(again).resolves.toBe('stopped');
    expect(notices).toHaveLength(1); // the interrupted error was not reported
  });

  it('remembers what it said, briefly, so its own echo can be recognised', () => {
    const { player, synth, tick } = ctx;
    tick(1000);
    void player.speak('You have one appointment tomorrow.');
    expect(player.recentSpoken()).toEqual([{ text: 'You have one appointment tomorrow.', at: 1000 }]);
    synth.finish();
    tick(20_000);
    void player.speak('Another reply entirely.');
    expect(player.recentSpoken().map((entry) => entry.text)).toEqual(['Another reply entirely.']); // older speech is forgotten
  });

  it('stops everything when disposed', async () => {
    const { player, synth } = ctx;
    const done = player.speak('Something long. And another sentence.');
    player.dispose();
    await expect(done).resolves.toBe('stopped');
    expect(synth.current).toBeNull();
  });
});
