'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatTime, formatTimeRange } from '@/lib/format';
import { useClinicToday } from '@/lib/hooks';
import { restoredNote } from './restored-note';
import type { DoctorAvailability, Session } from '@/lib/types';

interface EditorProps {
  session: Session;
  availability: DoctorAvailability;
  onSaved: () => void;
}

type Feedback = { tone: 'success' | 'error'; message: string } | null;

const selectClass =
  'h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const SLOT_LENGTHS = [10, 15, 20, 30, 45, 60];
const SLOT_INTERVALS = [5, 10, 15, 20, 30, 45, 60];
const FOLLOW = 'follow';

const toClock = (total: number) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** What the doctor's patients would see from 11:00: the first few slot windows for this length and interval. */
function previewWindows(length: number, interval: number): string[] {
  return [0, 1, 2, 3].map((n) => {
    const start = 11 * 60 + n * interval;
    return formatTimeRange(toClock(start), toClock(start + length));
  });
}

/** Edits how long each appointment is, and how often a new slot starts (shorter than the length makes slots overlap). */
export function SlotLengthEditor({ session, availability, onSaved }: EditorProps) {
  const [minutes, setMinutes] = useState(availability.consultationMinutes);
  const [interval, setIntervalChoice] = useState<number | typeof FOLLOW>(availability.slotIntervalCustom ? availability.slotIntervalMinutes : FOLLOW);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const lengths = SLOT_LENGTHS.includes(availability.consultationMinutes)
    ? SLOT_LENGTHS
    : [...SLOT_LENGTHS, availability.consultationMinutes].sort((a, b) => a - b);
  const intervals =
    availability.slotIntervalCustom && !SLOT_INTERVALS.includes(availability.slotIntervalMinutes)
      ? [...SLOT_INTERVALS, availability.slotIntervalMinutes].sort((a, b) => a - b)
      : SLOT_INTERVALS;

  const effectiveInterval = interval === FOLLOW ? minutes : interval;
  const lengthChanged = minutes !== availability.consultationMinutes;
  const intervalChanged = (interval === FOLLOW ? null : interval) !== (availability.slotIntervalCustom ? availability.slotIntervalMinutes : null);
  const overlapping = effectiveInterval < minutes;

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await api('/doctor-portal/settings', {
        method: 'PUT',
        token: session.accessToken,
        body: {
          ...(lengthChanged && { consultationMinutes: minutes }),
          ...(intervalChanged && { slotIntervalMinutes: interval === FOLLOW ? null : interval }),
        },
      });
      setFeedback({
        tone: 'success',
        message: `Saved. Patients now see ${minutes}-minute appointments, with a new slot starting every ${effectiveInterval} minutes.`,
      });
      onSaved();
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Default appointment length and slot interval
        </CardTitle>
        <CardDescription>
          Each appointment has a start and an end time. The interval is how often a new slot starts: when it is shorter than the
          appointment, slots overlap, and booking one blocks every window that shares time with it. The appointment length can only
          change when you have no upcoming appointments; the interval can change at any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="slot-length">Appointment length</Label>
            <select id="slot-length" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} className={selectClass}>
              {lengths.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="slot-interval">Start a new slot every</Label>
            <select
              id="slot-interval"
              value={interval}
              onChange={(event) => setIntervalChoice(event.target.value === FOLLOW ? FOLLOW : Number(event.target.value))}
              className={selectClass}
            >
              <option value={FOLLOW}>Same as appointment length ({minutes} min)</option>
              {intervals.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="rounded-lg bg-muted p-3 text-sm" aria-live="polite">
          <p className="font-medium text-foreground">
            Example from 11:00 AM {overlapping ? '(slots overlap)' : effectiveInterval > minutes ? '(gaps between slots)' : '(back to back)'}
          </p>
          <p className="mt-1 text-muted-foreground">{previewWindows(minutes, effectiveInterval).join(', ')}, …</p>
        </div>
        <Button size="lg" onClick={save} disabled={saving || (!lengthChanged && !intervalChanged)}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Adds one-off exceptions for specific dates (the `schedule_overrides` table). */
export function DateOverridesEditor({ session, availability, onSaved }: EditorProps) {
  const today = useClinicToday();
  const [date, setDate] = useState('');
  const [mode, setMode] = useState<'off' | 'block' | 'custom'>('off');
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('13:00');
  const [capacity, setCapacity] = useState(availability.defaultCapacity);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const run = async (work: () => Promise<{ restoredAppointments?: number }>, success: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const done = await work();
      setFeedback({ tone: 'success', message: `${success}${restoredNote(done.restoredAppointments)}` });
      onSaved();
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body =
      mode === 'off'
        ? { date, isAvailable: false, reason: reason || undefined }
        : mode === 'block'
          ? { date, isAvailable: false, startTime, endTime, reason: reason || undefined }
          : { date, isAvailable: true, startTime, endTime, capacity, reason: reason || undefined };
    void run(
      () => api<{ restoredAppointments?: number }>('/doctor-portal/availability/overrides', { method: 'PUT', token: session.accessToken, body }),
      `Saved the exception for ${formatDate(date)}.`,
    );
  };

  const remove = (overrideDate: string) =>
    run(
      () => api<{ restoredAppointments?: number }>(`/doctor-portal/availability/overrides/${overrideDate}`, { method: 'DELETE', token: session.accessToken }),
      `Removed the exception for ${formatDate(overrideDate)}. Regular weekly hours apply again.`,
    );

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Date exceptions
        </CardTitle>
        <CardDescription>
          Take a whole day off, block just part of a day, or set different hours for a specific date. Blocking part of a day removes only the
          slots that overlap it; different hours replace everything on that date and keep its usual scheduling mode and slot length.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}

        <form onSubmit={submit} className="grid gap-4 rounded-lg bg-muted p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="override-date">Date</Label>
            <Input
              id="override-date"
              type="date"
              required
              min={today ?? undefined}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 bg-card"
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Availability</legend>
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as 'off' | 'block' | 'custom')}
              className="flex flex-wrap gap-4 pt-1"
              aria-label="Availability"
            >
              <Label className="gap-2 font-normal">
                <RadioGroupItem value="off" /> Day off
              </Label>
              <Label className="gap-2 font-normal">
                <RadioGroupItem value="block" /> Block part of the day
              </Label>
              <Label className="gap-2 font-normal">
                <RadioGroupItem value="custom" /> Custom hours
              </Label>
            </RadioGroup>
          </fieldset>
          {mode !== 'off' && (
            <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
              <div className="space-y-2">
                <Label htmlFor="override-from">From</Label>
                <Input id="override-from" type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} className="h-9 w-32 bg-card" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="override-to">To</Label>
                <Input id="override-to" type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} className="h-9 w-32 bg-card" />
              </div>
              {mode === 'custom' && (
              <div className="space-y-2">
                <Label htmlFor="override-capacity">Capacity</Label>
                <Input
                  id="override-capacity"
                  type="number"
                  required
                  min={1}
                  max={200}
                  value={capacity}
                  onChange={(e) => setCapacity(Number(e.target.value))}
                  className="h-9 w-24 bg-card"
                />
              </div>
              )}
            </div>
          )}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="override-reason">Reason (optional)</Label>
            <Input
              id="override-reason"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Conference"
              className="h-9 bg-card"
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" size="lg" disabled={busy || !date}>
              {busy ? 'Saving…' : 'Save exception'}
            </Button>
          </div>
        </form>

        {availability.overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming exceptions.</p>
        ) : (
          <ul className="divide-y">
            {availability.overrides.map((o) => (
              <li key={o.date} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-semibold text-foreground">{formatDate(o.date, { weekday: 'long' })}</p>
                  <p className="text-muted-foreground">
                    {o.isAvailable && o.startTime && o.endTime
                      ? `Different hours ${formatTime(o.startTime)}–${formatTime(o.endTime)} · capacity ${o.capacity}`
                      : o.startTime && o.endTime
                        ? `Unavailable ${formatTime(o.startTime)}–${formatTime(o.endTime)} (rest of the day as usual)`
                        : 'Day off'}
                    {o.reason && ` · ${o.reason}`}
                  </p>
                </div>
                <Button variant="outline" disabled={busy} onClick={() => remove(o.date)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
