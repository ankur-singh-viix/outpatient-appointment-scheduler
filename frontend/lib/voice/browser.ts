import type { RecognitionLike, SynthLike, UtteranceLike } from './types';

/** What this browser can do. Everything is detected, never assumed: absent features simply leave their buttons off. */
export interface BrowserVoice {
  /** Speech to text. Null in browsers without SpeechRecognition (Firefox, and some in-app browsers). */
  createRecognition: (() => RecognitionLike) | null;
  /** Text to speech. */
  synth: SynthLike | null;
  createUtterance: ((text: string) => UtteranceLike) | null;
  /** Asks for the microphone with echo cancellation, noise suppression and gain control requested, then lets go of it at once. Null when the page cannot use a microphone. */
  acquireMic: (() => Promise<void>) | null;
  /** Speech recognition only works on https (or localhost). */
  secure: boolean;
}

type RecognitionConstructor = new () => RecognitionLike;
type VoiceWindow = Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };

export function detectBrowserVoice(win: Window = window): BrowserVoice {
  const voiceWindow = win as VoiceWindow;
  const Recognition = voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;
  const synthesis = 'speechSynthesis' in win && 'SpeechSynthesisUtterance' in win ? (win.speechSynthesis as unknown as SynthLike) : null;
  const media = win.navigator?.mediaDevices;
  return {
    createRecognition: Recognition ? () => new Recognition() : null,
    synth: synthesis,
    createUtterance: synthesis ? (text) => new (win as unknown as { SpeechSynthesisUtterance: new (text: string) => UtteranceLike }).SpeechSynthesisUtterance(text) : null,
    acquireMic: media?.getUserMedia
      ? async () => {
          // The page asks for processing that cancels the speakers' echo. Browsers run SpeechRecognition on their own capture, which a page
          // cannot configure, so this request mainly settles permission up front; the stream is released immediately (no recording is made).
          const stream = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          for (const track of stream.getTracks()) track.stop();
        }
      : null,
    secure: win.isSecureContext !== false,
  };
}
