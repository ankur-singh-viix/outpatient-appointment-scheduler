'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHydrated } from '@/lib/session';
import { detectBrowserVoice } from '@/lib/voice/browser';
import { languageChoice } from '@/lib/voice/languages';
import { SpeechListener } from '@/lib/voice/listener';
import { SpeechPlayer, type PlayerState } from '@/lib/voice/speech-player';
import type { VoiceErrorKind, VoiceLanguage } from '@/lib/voice/types';
import { VoiceSession, describeMicError, echoCheckFor, type Speaker, type VoiceState, type VoiceSubmit } from '@/lib/voice/voice-session';

/** What the browser can do, once the page is in the browser (null before that, so server and browser render the same). */
export interface VoiceSupport {
  /** Speech to text works here (the browser has it, and the page is secure). */
  listen: boolean;
  /** Text to speech works here. */
  speak: boolean;
  /** False on a plain http page (other than localhost): microphones are blocked there. */
  secure: boolean;
}

export interface AssistantVoiceOptions {
  language: VoiceLanguage;
  /** Whether replies are read aloud (a person's choice; never on by itself for old messages). */
  speakReplies: boolean;
  /** Sends a spoken turn through the ordinary assistant chat. */
  submitVoice: (text: string) => Promise<VoiceSubmit>;
  /** One dictated message, ready to be shown in the input box for the person to read, edit and send. */
  onDictated: (text: string) => void;
}

/** A browser with no speech synthesis can still listen: it just never speaks. */
const MUTE_SPEAKER: Speaker = { speak: async () => 'nothing', stop: () => undefined, recentSpoken: () => [] };

/**
 * Connects the framework-free voice engine (lib/voice) to the page. It adds no behaviour of its own: a spoken turn goes through the same
 * chat function as a typed one, and everything it starts (microphone, speech) is stopped when the person leaves, hides the tab or ends it.
 */
export function useAssistantVoice(options: AssistantVoiceOptions) {
  const hydrated = useHydrated();
  const browser = useMemo(() => (hydrated ? detectBrowserVoice() : null), [hydrated]);
  const support: VoiceSupport | null = useMemo(
    () => (browser ? { listen: Boolean(browser.createRecognition) && browser.secure, speak: Boolean(browser.synth && browser.createUtterance), secure: browser.secure } : null),
    [browser],
  );
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const [voice, setVoice] = useState<VoiceState>('idle');
  const [dictating, setDictating] = useState(false);
  const [interim, setInterim] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ kind: VoiceErrorKind; message: string } | null>(null);
  const [speech, setSpeech] = useState<{ state: PlayerState; id: string | null }>({ state: 'idle', id: null });

  const engine = useRef<{ player: SpeechPlayer | null; session: VoiceSession | null; dictation: SpeechListener | null; acquireMic: (() => Promise<void>) | null } | null>(null);

  useEffect(() => {
    if (!browser) return;
    const player = browser.synth && browser.createUtterance ? new SpeechPlayer({ synth: browser.synth, createUtterance: browser.createUtterance }) : null;
    player?.setHandlers({ onState: (state, id) => setSpeech({ state, id }), onNotice: setNotice });
    let session: VoiceSession | null = null;
    let dictation: SpeechListener | null = null;
    if (browser.createRecognition && browser.secure) {
      const create = browser.createRecognition;
      const speaker: Speaker = player ?? MUTE_SPEAKER;
      session = new VoiceSession({
        listener: new SpeechListener({ createRecognition: create, isEcho: echoCheckFor(speaker) }),
        player: speaker,
        acquireMic: browser.acquireMic ?? (async () => undefined),
        submit: (text) => latest.current.submitVoice(text),
        speakReplies: () => latest.current.speakReplies && player !== null,
        recognitionLocale: () => languageChoice(latest.current.language).recognition,
        latinSpeechLocale: () => languageChoice(latest.current.language).speech,
        onState: (state) => {
          setVoice(state);
          if (state !== 'listening') setInterim(''); // the caption belongs to the turn being spoken, not to the answer
        },
        onInterim: setInterim,
        onNotice: setNotice,
        onError: (kind, message) => setProblem({ kind, message }),
        onEnded: () => setInterim(''),
      });
      dictation = new SpeechListener({ createRecognition: create });
      dictation.setHandlers({
        onInterim: setInterim,
        onTurn: (text) => {
          setDictating(false);
          setInterim('');
          latest.current.onDictated(text);
        },
        onSilence: () => {
          setDictating(false);
          setInterim('');
          setNotice("I didn't catch that. Press the microphone and try again, or type.");
        },
        onError: (kind, message) => {
          setDictating(false);
          setInterim('');
          setProblem({ kind, message });
        },
      });
    }
    engine.current = { player, session, dictation, acquireMic: browser.acquireMic };

    // Nothing may keep listening or talking after the person has left: leaving, hiding the tab, or unmounting ends it all.
    const stopAll = () => {
      session?.stop('user');
      dictation?.stop();
      player?.stop();
      setDictating(false);
      setInterim('');
    };
    const onHidden = () => {
      if (document.hidden) stopAll();
    };
    window.addEventListener('pagehide', stopAll);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', stopAll);
      document.removeEventListener('visibilitychange', onHidden);
      stopAll();
      player?.dispose();
      engine.current = null;
    };
  }, [browser]);

  /** Starts the hands-free conversation (the person pressed Start voice conversation). */
  const startVoice = useCallback(() => {
    const parts = engine.current;
    if (!parts?.session) return;
    setProblem(null);
    setNotice(null);
    parts.dictation?.stop();
    setDictating(false);
    parts.player?.stop();
    void parts.session.start();
  }, []);

  const stopVoice = useCallback(() => engine.current?.session?.stop('user'), []);
  const interrupt = useCallback(() => engine.current?.session?.interrupt(), []);

  /** One-shot dictation: listens for a single message and puts it in the input box, WITHOUT sending it. */
  const toggleDictation = useCallback(async () => {
    const parts = engine.current;
    if (!parts?.dictation) return;
    if (parts.dictation.listening) {
      parts.dictation.commitNow(); // "that's all": keep what was heard
      return;
    }
    setProblem(null);
    setNotice(null);
    parts.session?.stop('user');
    parts.player?.stop();
    try {
      await parts.acquireMic?.();
    } catch (error) {
      setProblem(describeMicError(error));
      return;
    }
    setDictating(true);
    parts.dictation.start(languageChoice(latest.current.language).recognition);
  }, []);

  const stopDictation = useCallback(() => {
    engine.current?.dictation?.stop();
    setDictating(false);
    setInterim('');
  }, []);

  const speakMessage = useCallback((id: string, text: string) => {
    const parts = engine.current;
    if (!parts?.player) return;
    parts.dictation?.stop();
    setDictating(false);
    void parts.player.speak(text, { id, latinLocale: languageChoice(latest.current.language).speech });
  }, []);

  return {
    support,
    voice,
    dictating,
    interim,
    notice,
    problem,
    speech,
    clearNotice: () => {
      setNotice(null);
      setProblem(null);
    },
    startVoice,
    stopVoice,
    interrupt,
    toggleDictation,
    stopDictation,
    speakMessage,
    pauseSpeech: () => engine.current?.player?.pause(),
    resumeSpeech: () => engine.current?.player?.resume(),
    stopSpeech: () => engine.current?.player?.stop(),
  };
}
