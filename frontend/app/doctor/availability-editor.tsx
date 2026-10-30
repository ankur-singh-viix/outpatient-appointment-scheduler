'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { api, errorMessage } from '@/lib/api';
import { DAY_LONG, WEEK_ORDER, formatDate, formatTime, formatTimeRange } from '@/lib/format';
import { useClinicToday } from '@/lib/hooks';
import type { DoctorAvailability, Session, WeeklyHours } from '@/lib/types';

interface EditorProps {
  session: Session;
  availability: DoctorAvailability;
  onSaved: () => void;
}

type Feedback = { tone: 'success' | 'error'; message: string } | null;

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

  const selectClass =
    'h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Appointment length and slot interval
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

/** Edits the recurring weekly schedule (the `availability` table). */
export function WeeklyHoursEditor({ session, availability, onSaved }: EditorProps) {
  const [rows, setRows] = useState<WeeklyHours[]>(availability.weekly);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const update = (index: number, patch: Partial<WeeklyHours>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const remove = (index: number) => setRows((current) => current.filter((_, i) => i !== index));
  const add = (dayOfWeek: number) =>
    setRows((current) => [
      ...current,
      { dayOfWeek, startTime: '09:00', endTime: '13:00', capacity: availability.defaultCapacity },
    ]);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await api<DoctorAvailability>('/doctor-portal/availability/weekly', {
        method: 'PUT',
        token: session.accessToken,
        body: { hours: rows },
      });
      setRows(saved.weekly); // the server's tidied-up order, without remounting the editor (which would wipe the message below)
      setFeedback({ tone: 'success', message: 'Weekly hours saved. Patients now see the updated slots.' });
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
          Weekly working hours
        </CardTitle>
        <CardDescription>
          Patients book {availability.consultationMinutes}-minute appointments inside these hours, with a new slot starting every{' '}
          {availability.slotIntervalMinutes} minutes. Capacity is the maximum number of bookings per session.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}

        <div className="divide-y">
          {WEEK_ORDER.map((day) => {
            const sessions = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.dayOfWeek === day);
            return (
              <div key={day} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
                <p className="w-28 shrink-0 pt-2 text-sm font-semibold text-foreground">{DAY_LONG[day]}</p>
                <div className="flex-1 space-y-2">
                  {sessions.length === 0 && <p className="pt-2 text-sm text-muted-foreground">Not working</p>}
                  {sessions.map(({ row, index }) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <Input
                        type="time"
                        aria-label={`${DAY_LONG[day]} start time`}
                        value={row.startTime}
                        onChange={(e) => update(index, { startTime: e.target.value })}
                        className="h-9 w-32"
                      />
                      <span className="text-muted-foreground">to</span>
                      <Input
                        type="time"
                        aria-label={`${DAY_LONG[day]} end time`}
                        value={row.endTime}
                        onChange={(e) => update(index, { endTime: e.target.value })}
                        className="h-9 w-32"
                      />
                      <Label className="gap-2 font-normal text-muted-foreground">
                        Capacity
                        <Input
                          type="number"
                          min={1}
                          max={200}
                          value={row.capacity}
                          onChange={(e) => update(index, { capacity: Number(e.target.value) })}
                          className="h-9 w-20"
                        />
                      </Label>
                      <Button type="button" variant="destructive" size="sm" onClick={() => remove(index)}>
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
                <Button type="button" variant="link" onClick={() => add(day)} className="justify-start sm:mt-0.5">
                  + Add session
                </Button>
              </div>
            );
          })}
        </div>

        <Button size="lg" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save weekly hours'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Adds one-off exceptions for specific dates (the `schedule_overrides` table). */
export function DateOverridesEditor({ session, availability, onSaved }: EditorProps) {
  const today = useClinicToday();
  const [date, setDate] = useState('');
  const [mode, setMode] = useState<'off' | 'custom'>('off');
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('13:00');
  const [capacity, setCapacity] = useState(availability.defaultCapacity);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      await work();
      setFeedback({ tone: 'success', message: success });
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
        : { date, isAvailable: true, startTime, endTime, capacity, reason: reason || undefined };
    void run(
      () => api('/doctor-portal/availability/overrides', { method: 'PUT', token: session.accessToken, body }),
      `Saved the exception for ${formatDate(date)}.`,
    );
  };

  const remove = (overrideDate: string) =>
    run(
      () => api(`/doctor-portal/availability/overrides/${overrideDate}`, { method: 'DELETE', token: session.accessToken }),
      `Removed the exception for ${formatDate(overrideDate)}. Regular weekly hours apply again.`,
    );

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Date exceptions
        </CardTitle>
        <CardDescription>
          Take a day off or set different hours for a specific date. This replaces your weekly hours for that date.
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
              onValueChange={(value) => setMode(value as 'off' | 'custom')}
              className="flex gap-4 pt-1"
              aria-label="Availability"
            >
              <Label className="gap-2 font-normal">
                <RadioGroupItem value="off" /> Day off
              </Label>
              <Label className="gap-2 font-normal">
                <RadioGroupItem value="custom" /> Custom hours
              </Label>
            </RadioGroup>
          </fieldset>
          {mode === 'custom' && (
            <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
              <div className="space-y-2">
                <Label htmlFor="override-from">From</Label>
                <Input id="override-from" type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} className="h-9 w-32 bg-card" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="override-to">To</Label>
                <Input id="override-to" type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} className="h-9 w-32 bg-card" />
              </div>
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
                      ? `${formatTime(o.startTime)}–${formatTime(o.endTime)} · capacity ${o.capacity}`
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
