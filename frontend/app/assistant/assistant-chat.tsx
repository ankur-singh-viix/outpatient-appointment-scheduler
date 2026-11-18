'use client';

import { AudioLinesIcon, BotIcon, MicIcon, PauseIcon, PlayIcon, RotateCcwIcon, SendIcon, SquareIcon, UserRoundIcon, Volume2Icon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, PageHeader } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Button } from '@/components/ui/button';
import { ApiError, api, errorMessage } from '@/lib/api';
import { CARD_EXPIRED_TEXT, turnsFromStored } from '@/lib/assistant-history';
import { assistantFooterText } from '@/lib/care-assistant';
import type { ActionCard, AssistantReply, ConversationSummary, Role, Session, StoredMessage } from '@/lib/types';
import { LANGUAGES } from '@/lib/voice/languages';
import type { VoiceLanguage } from '@/lib/voice/types';
import type { VoiceSubmit } from '@/lib/voice/voice-session';
import { cn } from '@/lib/utils';
import { ActionCardView } from './action-card';
import { HistoryPanel } from './history-panel';
import { useAssistantVoice } from './use-voice';

const MAX_LENGTH = 2000;
/** How many earlier turns are sent along with a new message. The server keeps no chat, so this is the whole memory. */
const HISTORY_SENT = 10;
/** The server gives one answer at most about a minute; this is only the backstop for a request that never comes back. */
const CHAT_TIMEOUT_MS = 100_000;
const LANGUAGE_KEY = 'careslot.assistant.language';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** What the assistant looked up to answer, shown under its reply. */
  looked?: string[];
  /** A confirmation card the server attached to this reply: nothing has happened until the patient presses its button. */
  cards?: ActionCard[];
  /** A saved reply that once had a card: shown as plain "Card expired" text, never as a button. */
  cardExpired?: boolean;
}

const LOOKED: Record<string, string> = {
  get_appointments_on_date: 'appointments',
  get_appointment_statistics: 'statistics',
  get_working_hours: 'working hours',
  find_scheduling_conflicts: 'conflicts',
  get_next_available_slot: 'next open slot',
  get_my_appointments: 'your appointments',
  search_doctors: 'doctors',
  get_available_slots: 'open slots',
  suggest_alternative_slots: 'other times',
  prepare_booking: 'a booking to confirm',
  prepare_reschedule: 'a move to confirm',
  prepare_cancellation: 'a cancellation to confirm',
  get_payment_status: 'payment status',
  get_refund_status: 'refund status',
};

const SUGGESTIONS: Partial<Record<Role, string[]>> = {
  DOCTOR: ["What's on my schedule today?", 'How many appointments did I have in the last 30 days?', 'Do I have any scheduling conflicts?', 'When is my next open slot?', 'What are my working hours?'],
  PATIENT: ['What are my upcoming appointments?', 'Book an appointment with a cardiologist', 'Move my next appointment to another time', 'Cancel my next appointment', 'What slots does Dr. Rao have tomorrow?'],
};

const STATUS_TEXT = { starting: 'Starting the microphone…', listening: 'Listening… speak now', processing: 'Thinking…', speaking: 'Speaking…' } as const;

function readLanguage(): VoiceLanguage {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_KEY);
    return stored === 'hi' || stored === 'hinglish' ? stored : 'en';
  } catch {
    return 'en';
  }
}

/** The chat for doctors and patients. It can look things up (and, for patients, prepare a change that only their own Confirm press carries out). */
export function AssistantChat() {
  return (
    <RequireRole role={['DOCTOR', 'PATIENT']} nextPath="/assistant">
      {(session) => <Conversation session={session} />}
    </RequireRole>
  );
}

function Conversation({ session }: { session: Session }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAsked, setLastAsked] = useState<string | null>(null);
  // The saved conversation these turns belong to (null until the first reply is saved), and a counter that tells the history list to refresh.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  // Only mounted in the browser (after sign-in), so the stored choice can be read straight away.
  const [language, setLanguageState] = useState<VoiceLanguage>(() => (typeof window === 'undefined' ? 'en' : readLanguage()));
  const [speakReplies, setSpeakReplies] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const dictated = useRef(false);
  const counter = useRef(0);
  const sendRef = useRef<(raw: string, options?: { resend?: boolean; via?: 'voice' }) => Promise<VoiceSubmit>>(async () => ({ error: 'Not ready.' }));
  const role = session.user.role;
  const newId = () => `t${++counter.current}`;

  const voice = useAssistantVoice({
    language,
    speakReplies,
    submitVoice: (said) => sendRef.current(said, { via: 'voice' }),
    onDictated: (said) => {
      dictated.current = true;
      setText((current) => (current.trim() ? `${current.trim()} ${said}` : said));
      inputRef.current?.focus();
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns, sending, error]);

  const chooseLanguage = (value: VoiceLanguage) => {
    setLanguageState(value);
    try {
      window.localStorage.setItem(LANGUAGE_KEY, value);
    } catch {
      /* the choice just is not remembered */
    }
  };

  /**
   * Sends one message through the ordinary assistant chat: typed, dictated and spoken messages all take this same path, with the same
   * authentication, role rules and confirmation cards. `voice`/`language` are only hints about wording. Returns what the voice session
   * needs (the reply to read, or why there is none).
   */
  const send = async (raw: string, options: { resend?: boolean; via?: 'voice' } = {}): Promise<VoiceSubmit> => {
    const content = raw.trim();
    if (!content) return { error: 'There was nothing to send.' };
    if (busy.current) return { busy: true }; // a double click, a held Enter or a spoken turn during a typed one sends once
    busy.current = true;
    setSending(true);
    setError(null);
    setLastAsked(content);
    if (options.via !== 'voice') voice.stopSpeech();
    const history = options.resend ? turns : [...turns, { id: newId(), role: 'user' as const, content }];
    if (!options.resend) {
      setTurns(history);
      setText('');
    }
    const hints = { ...(options.via === 'voice' || speakReplies ? { voice: true } : {}), ...(options.via === 'voice' || dictated.current ? { language } : {}) };
    dictated.current = false;
    try {
      const reply = await api<AssistantReply>('/assistant/chat', {
        method: 'POST',
        token: session.accessToken,
        timeoutMs: CHAT_TIMEOUT_MS,
        body: { messages: history.slice(-HISTORY_SENT).map(({ role: from, content: said }) => ({ role: from, content: said })), ...(conversationId ? { conversationId } : {}), ...hints },
      });
      if (reply.conversationId) {
        setConversationId(reply.conversationId);
        setHistoryVersion((version) => version + 1);
      }
      const id = newId();
      setTurns((current) => [...current, { id, role: 'assistant', content: reply.reply, looked: [...new Set(reply.toolsUsed.map((name) => LOOKED[name] ?? name))], cards: reply.actions }]);
      // A voice conversation reads the reply itself; in text mode it is read only if the person turned spoken replies on.
      if (options.via !== 'voice' && speakReplies) voice.speakMessage(id, reply.reply);
      return { reply: reply.reply };
    } catch (err) {
      // The saved conversation is gone (deleted elsewhere): the next try starts a new one instead of failing again.
      if (err instanceof ApiError && err.status === 404 && conversationId) setConversationId(null);
      const message = errorMessage(err);
      setError(message);
      return { error: message };
    } finally {
      busy.current = false;
      setSending(false);
      if (options.via !== 'voice') inputRef.current?.focus();
    }
  };
  useEffect(() => {
    sendRef.current = send;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(text);
    }
  };

  /** What the server reported about a card (done, refused, expired, paid) goes into the conversation, so the assistant knows how it ended. */
  const outcome = (message: string) => setTurns((current) => [...current, { id: newId(), role: 'assistant', content: message }]);

  const reset = () => {
    if (busy.current) return;
    voice.stopSpeech();
    setTurns([]);
    setConversationId(null);
    setError(null);
    setLastAsked(null);
    setText('');
    inputRef.current?.focus();
  };

  /** Loads a saved conversation. Only text comes back: replies that had a card show "Card expired", and nothing in it can be pressed. */
  const openConversation = async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    voice.stopSpeech();
    setError(null);
    try {
      const saved = await api<ConversationSummary & { messages: StoredMessage[] }>(`/assistant/conversations/${id}`, { token: session.accessToken });
      setTurns(
        turnsFromStored(saved.messages).map((turn) => ({
          id: turn.id,
          role: turn.role,
          content: turn.content,
          looked: turn.toolNames.length > 0 ? [...new Set(turn.toolNames.map((name) => LOOKED[name] ?? name))] : undefined,
          cardExpired: turn.cardExpired,
        })),
      );
      setConversationId(saved.id);
      setLastAsked(null);
      setText('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      busy.current = false;
    }
  };

  const support = voice.support;
  const voiceOn = voice.voice !== 'idle';
  const canListen = support?.listen === true;
  const unsupportedReason = support && !canListen ? (!support.secure ? 'Voice needs a secure (https) page.' : "Voice input isn't supported in this browser. Chrome or Edge works best; you can still type.") : null;

  return (
    <div className="mx-auto grid max-w-5xl gap-4 animate-in fade-in-0 duration-300 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <HistoryPanel session={session} activeId={conversationId} version={historyVersion} disabled={sending || voiceOn} onOpen={(id) => void openConversation(id)} onNew={reset} onDeleted={(id) => id === conversationId && reset()} />
      <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Assistant"
        description={role === 'DOCTOR' ? 'Ask about your schedule, appointments and availability.' : 'Ask about your appointments, doctors and open times.'}
        action={
          turns.length > 0 ? (
            <Button variant="outline" size="sm" onClick={reset} disabled={sending || voiceOn}>
              <RotateCcwIcon aria-hidden /> New chat
            </Button>
          ) : undefined
        }
      />

      <div className="flex min-h-[26rem] flex-col rounded-xl border bg-card">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" role="log" aria-live="polite" aria-label="Conversation" style={{ maxHeight: '60dvh' }}>
          {turns.length === 0 && (
            <div className="space-y-3 py-6 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden>
                <BotIcon className="size-6" />
              </span>
              <p className="font-medium text-foreground">How can I help, {session.user.name.split(' ')[0]}?</p>
              <ul className="flex flex-wrap justify-center gap-2" aria-label="Suggested questions">
                {(SUGGESTIONS[role] ?? []).map((suggestion) => (
                  <li key={suggestion}>
                    <Button variant="outline" size="sm" disabled={sending} onClick={() => void send(suggestion)}>
                      {suggestion}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {turns.map((turn) => (
            <div key={turn.id} className={cn('flex gap-3', turn.role === 'user' && 'flex-row-reverse')}>
              <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', turn.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground')} aria-hidden>
                {turn.role === 'user' ? <UserRoundIcon className="size-4" /> : <BotIcon className="size-4" />}
              </span>
              <div className={cn('max-w-[85%] space-y-1', turn.role === 'user' && 'items-end text-right')}>
                <p className="sr-only">{turn.role === 'user' ? 'You said' : 'Assistant said'}</p>
                {/* Plain text only: the reply is never interpreted as HTML. */}
                <p className={cn('inline-block rounded-2xl px-4 py-2 text-left text-sm whitespace-pre-wrap', turn.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>{turn.content}</p>
                {turn.cardExpired && <p className="text-xs text-muted-foreground">{CARD_EXPIRED_TEXT}</p>}
                {turn.looked && turn.looked.length > 0 && <p className="text-xs text-muted-foreground">Looked up: {turn.looked.join(', ')}</p>}
                {turn.role === 'assistant' && support?.speak && <ListenControls id={turn.id} text={turn.content} voice={voice} />}
                {turn.cards?.map((card) => (
                  <div key={card.ref} className="pt-2 text-left">
                    <ActionCardView card={card} session={session} onOutcome={outcome} />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
              <span className="flex size-8 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden>
                <BotIcon className="size-4 animate-pulse" />
              </span>
              Looking that up…
            </div>
          )}

          {error && (
            <Alert
              action={
                lastAsked ? (
                  <Button size="sm" variant="outline" onClick={() => void send(lastAsked, { resend: true })} disabled={sending}>
                    Try again
                  </Button>
                ) : undefined
              }
            >
              {error}
            </Alert>
          )}
          <div ref={endRef} />
        </div>

        <form
          className="space-y-2 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send(text);
          }}
        >
          {voice.problem && (
            <Alert
              action={
                <Button type="button" size="sm" variant="outline" onClick={voice.clearNotice}>
                  Dismiss
                </Button>
              }
            >
              {voice.problem.message}
            </Alert>
          )}
          {voice.notice && !voice.problem && (
            <Alert
              tone="info"
              action={
                <Button type="button" size="sm" variant="outline" onClick={voice.clearNotice}>
                  Dismiss
                </Button>
              }
            >
              {voice.notice}
            </Alert>
          )}

          {(voiceOn || voice.dictating) && (
            <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm" role="status" aria-live="polite" aria-label="Voice status">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <span className={cn('size-2.5 rounded-full', voice.voice === 'listening' || voice.dictating ? 'animate-pulse bg-red-500' : voice.voice === 'speaking' ? 'animate-pulse bg-primary' : 'bg-amber-500')} aria-hidden />
                  {voice.dictating ? 'Listening… press the microphone when you are done' : STATUS_TEXT[voice.voice as keyof typeof STATUS_TEXT]}
                </p>
                <div className="flex flex-wrap gap-2">
                  {voice.voice === 'speaking' && (
                    <>
                      {voice.speech.state === 'paused' ? (
                        <Button type="button" size="sm" variant="outline" onClick={voice.resumeSpeech}>
                          <PlayIcon aria-hidden /> Resume
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={voice.pauseSpeech}>
                          <PauseIcon aria-hidden /> Pause
                        </Button>
                      )}
                      <Button type="button" size="sm" variant="outline" onClick={voice.interrupt}>
                        <SquareIcon aria-hidden /> Stop speaking
                      </Button>
                    </>
                  )}
                  {voiceOn && (
                    <Button type="button" size="sm" onClick={voice.stopVoice}>
                      Stop voice mode
                    </Button>
                  )}
                  {voice.dictating && (
                    <Button type="button" size="sm" variant="outline" onClick={voice.stopDictation}>
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
              {voice.interim && <p className="text-muted-foreground italic">“{voice.interim}”</p>}
            </div>
          )}

          <label htmlFor="assistant-input" className="sr-only">
            Ask the assistant
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id="assistant-input"
              ref={inputRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              maxLength={MAX_LENGTH}
              rows={2}
              placeholder="Ask a question, or press the microphone to speak…"
              className="min-h-10 flex-1 resize-none rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <Button
              type="button"
              variant={voice.dictating ? 'default' : 'outline'}
              size="lg"
              className="h-10"
              aria-label={voice.dictating ? 'Stop dictating' : 'Dictate a message'}
              aria-pressed={voice.dictating}
              title={unsupportedReason ?? (voice.dictating ? 'Stop dictating' : 'Speak your message; you can edit it before sending')}
              disabled={!canListen || voiceOn || sending}
              onClick={() => void voice.toggleDictation()}
            >
              <MicIcon aria-hidden />
            </Button>
            <Button type="submit" size="lg" className="h-10 gap-2" disabled={sending || text.trim().length === 0}>
              <SendIcon aria-hidden /> Send
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <Button
              type="button"
              variant={voiceOn ? 'default' : 'outline'}
              size="sm"
              aria-pressed={voiceOn}
              disabled={!canListen}
              title={unsupportedReason ?? undefined}
              onClick={() => (voiceOn ? voice.stopVoice() : (setSpeakReplies(true), voice.startVoice()))}
            >
              <AudioLinesIcon aria-hidden /> {voiceOn ? 'Stop voice conversation' : 'Start voice conversation'}
            </Button>
            <label className="flex items-center gap-2 text-muted-foreground">
              Language
              <select
                value={language}
                onChange={(event) => chooseLanguage(event.target.value as VoiceLanguage)}
                className="h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {LANGUAGES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            {support?.speak && (
              <label className="flex items-center gap-2 text-muted-foreground">
                <input type="checkbox" checked={speakReplies} onChange={(event) => setSpeakReplies(event.target.checked)} className="size-4 accent-primary" />
                Speak replies
              </label>
            )}
          </div>

          {unsupportedReason && <p className="text-xs text-muted-foreground">{unsupportedReason}</p>}
          {canListen && <p className="text-xs text-muted-foreground">Voice uses your browser&apos;s speech service: in Chrome and Edge your audio may be processed by Google or Microsoft. CareSlot does not record or store audio, and the microphone is on only while you see “Listening”.</p>}
          <p className="text-xs text-muted-foreground">{assistantFooterText(role)}</p>
        </form>
      </div>
      </div>
    </div>
  );
}

/** Listen / Pause / Resume / Stop for one assistant message. The written reply stays on screen while it is read. */
function ListenControls({ id, text, voice }: { id: string; text: string; voice: ReturnType<typeof useAssistantVoice> }) {
  const mine = voice.speech.id === id && voice.speech.state !== 'idle';
  return (
    <div className="flex flex-wrap gap-1 text-left">
      {!mine ? (
        <Button type="button" variant="ghost" size="sm" aria-label="Listen to this reply" onClick={() => voice.speakMessage(id, text)}>
          <Volume2Icon aria-hidden /> Listen
        </Button>
      ) : (
        <>
          {voice.speech.state === 'paused' ? (
            <Button type="button" variant="ghost" size="sm" aria-label="Resume reading" onClick={voice.resumeSpeech}>
              <PlayIcon aria-hidden /> Resume
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" aria-label="Pause reading" onClick={voice.pauseSpeech}>
              <PauseIcon aria-hidden /> Pause
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" aria-label="Stop reading" onClick={voice.stopSpeech}>
            <SquareIcon aria-hidden /> Stop
          </Button>
        </>
      )}
    </div>
  );
}
