import { describe, expect, it, vi } from 'vitest';
import { detectBrowserVoice } from './browser';

/** A stand-in for `window` with only the features a given browser has. */
function windowWith(features: { recognition?: 'standard' | 'webkit'; synthesis?: boolean; mic?: boolean; secure?: boolean }): Window {
  const stream = { getTracks: () => [{ stop: vi.fn() }] };
  const fake: Record<string, unknown> = {
    isSecureContext: features.secure ?? true,
    navigator: { mediaDevices: features.mic === false ? undefined : { getUserMedia: vi.fn(async () => stream) } },
  };
  class Recognition {}
  if (features.recognition === 'standard') fake.SpeechRecognition = Recognition;
  if (features.recognition === 'webkit') fake.webkitSpeechRecognition = Recognition;
  if (features.synthesis) {
    fake.speechSynthesis = { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [] };
    fake.SpeechSynthesisUtterance = class {
      constructor(public text: string) {}
    };
  }
  return fake as unknown as Window;
}

describe('detectBrowserVoice: what each kind of browser gets', () => {
  it('Chrome/Edge style (prefixed recognition, synthesis, microphone): everything is on', () => {
    const voice = detectBrowserVoice(windowWith({ recognition: 'webkit', synthesis: true }));
    expect(voice.createRecognition).toBeTypeOf('function');
    expect(voice.synth).not.toBeNull();
    expect(voice.createUtterance?.('hello')).toMatchObject({ text: 'hello' });
    expect(voice.acquireMic).toBeTypeOf('function');
    expect(voice.secure).toBe(true);
  });

  it('a browser with the standard, unprefixed recognition is supported too', () => {
    expect(detectBrowserVoice(windowWith({ recognition: 'standard', synthesis: true })).createRecognition).toBeTypeOf('function');
  });

  it('Firefox style (no recognition): listening is off, speaking still works', () => {
    const voice = detectBrowserVoice(windowWith({ synthesis: true }));
    expect(voice.createRecognition).toBeNull();
    expect(voice.synth).not.toBeNull();
  });

  it('a browser with recognition but no speech synthesis can listen and just never speaks', () => {
    const voice = detectBrowserVoice(windowWith({ recognition: 'webkit' }));
    expect(voice.createRecognition).toBeTypeOf('function');
    expect(voice.synth).toBeNull();
    expect(voice.createUtterance).toBeNull();
  });

  it('a plain http page (not secure) is reported, so the interface can say why voice is off', () => {
    expect(detectBrowserVoice(windowWith({ recognition: 'webkit', synthesis: true, secure: false })).secure).toBe(false);
  });

  it('a page with no microphone API has no way to ask for permission up front', () => {
    expect(detectBrowserVoice(windowWith({ recognition: 'webkit', mic: false })).acquireMic).toBeNull();
  });

  it('asks for the microphone with echo cancellation, noise suppression and gain control, and releases it at once', async () => {
    const win = windowWith({ recognition: 'webkit' });
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
    (win.navigator as unknown as { mediaDevices: unknown }).mediaDevices = { getUserMedia };
    await detectBrowserVoice(win).acquireMic!();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true); // nothing is left open
  });

  it('passes a refused microphone up unchanged, so it can be explained', async () => {
    const win = windowWith({ recognition: 'webkit' });
    (win.navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      },
    };
    await expect(detectBrowserVoice(win).acquireMic!()).rejects.toMatchObject({ name: 'NotAllowedError' });
  });
});
