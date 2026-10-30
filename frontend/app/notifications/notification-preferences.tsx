'use client';

import { BellRingIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { NotificationPreferencesView, Session } from '@/lib/types';

type Choice = 'smsEnabled' | 'emailReminders' | 'smsReminders' | 'promotionalEmail' | 'promotionalSms';

function Option({
  id,
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4.5 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-60"
      />
      <label htmlFor={id} className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}>
        <span className="block text-sm font-medium text-foreground">{title}</span>
        {hint && (
          <span id={`${id}-hint`} className="mt-0.5 block text-sm text-muted-foreground">
            {hint}
          </span>
        )}
      </label>
    </div>
  );
}

/**
 * How the patient wants to be contacted. Essential appointment, payment and refund emails are always sent and are not a choice
 * here (they are explained at the top); the choices are texts, reminders and, separately and off by default, promotional messages.
 * Each change is saved as soon as it is made.
 */
export function NotificationPreferences({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const loaded = useQuery(`notification-preferences:${session.user.id}`, () => api<NotificationPreferencesView>('/notifications/preferences', { token: session.accessToken }));
  const [latest, setLatest] = useState<NotificationPreferencesView | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const prefs = latest ?? loaded.data;

  const change = async (patch: Partial<Record<Choice, boolean>>) => {
    const before = prefs;
    if (!before) return;
    setLatest({ ...before, ...patch }); // show the change at once; it is put back if saving fails
    setSaving(true);
    setFeedback(null);
    try {
      setLatest(await api<NotificationPreferencesView>('/notifications/preferences', { method: 'PUT', token: session.accessToken, body: patch }));
      setFeedback({ tone: 'success', text: 'Saved.' });
      onChanged();
    } catch (error) {
      setLatest(before);
      setFeedback({ tone: 'error', text: `Your change was not saved. ${errorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  };

  const smsNote = !prefs
    ? null
    : !prefs.smsServiceAvailable
      ? 'Text messages are not available at the moment, so only emails are sent.'
      : !prefs.smsNumberOnFile
        ? 'We do not have a phone number with a country code for you, so texts cannot be sent yet.'
        : null;

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2 text-lg font-semibold">
          <BellRingIcon className="size-5 text-primary" aria-hidden />
          Notification preferences
        </CardTitle>
        <CardDescription>
          Booking, cancellation, rescheduling, payment and refund updates are always emailed to you: they are essential to your
          appointment, so they cannot be turned off. You choose the rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loaded.error && !prefs && <Alert>Could not load your preferences. {loaded.error}</Alert>}
        {prefs && (
          <>
            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-semibold text-foreground">Text messages</legend>
              <Option
                id="pref-sms"
                title="Also text me essential updates"
                hint={smsNote ?? 'The same updates, as a short text message. Turn this off to receive them by email only; it also stops reminder and promotional texts.'}
                checked={prefs.smsEnabled}
                disabled={saving}
                onChange={(next) => void change({ smsEnabled: next })}
              />
            </fieldset>

            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-semibold text-foreground">Appointment reminders</legend>
              <Option
                id="pref-email-reminders"
                title="Email me a reminder before my appointments"
                checked={prefs.emailReminders}
                disabled={saving}
                onChange={(next) => void change({ emailReminders: next })}
              />
              <Option
                id="pref-sms-reminders"
                title="Text me a reminder before my appointments"
                hint={!prefs.smsEnabled ? 'Texts are turned off above.' : undefined}
                checked={prefs.smsReminders && prefs.smsEnabled}
                disabled={saving || !prefs.smsEnabled}
                onChange={(next) => void change({ smsReminders: next })}
              />
            </fieldset>

            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-semibold text-foreground">Offers and health tips (optional)</legend>
              <p className="px-2 pb-1 text-sm text-muted-foreground">
                We do not send any of these today. If you tick a box, that records your permission for the future, with today&apos;s date. You can
                untick it at any time.
              </p>
              <Option
                id="pref-promo-email"
                title="I agree to receive offers and health tips by email"
                hint={prefs.promotionalEmailConsentAt ? `You agreed on ${formatDateTime(prefs.promotionalEmailConsentAt)}.` : undefined}
                checked={prefs.promotionalEmail}
                disabled={saving}
                onChange={(next) => void change({ promotionalEmail: next })}
              />
              <Option
                id="pref-promo-sms"
                title="I agree to receive offers and health tips by text message"
                hint={
                  !prefs.smsEnabled
                    ? 'Texts are turned off above.'
                    : prefs.promotionalSmsConsentAt
                      ? `You agreed on ${formatDateTime(prefs.promotionalSmsConsentAt)}.`
                      : undefined
                }
                checked={prefs.promotionalSms && prefs.smsEnabled}
                disabled={saving || !prefs.smsEnabled}
                onChange={(next) => void change({ promotionalSms: next })}
              />
            </fieldset>
          </>
        )}
        <div aria-live="polite" className="min-h-6">
          {feedback && (
            <p className={feedback.tone === 'success' ? 'text-sm font-medium text-emerald-700' : 'text-sm font-medium text-destructive'}>{feedback.text}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
