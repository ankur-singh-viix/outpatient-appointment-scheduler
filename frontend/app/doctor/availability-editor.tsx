'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { api, errorMessage } from '@/lib/api';
import { DAY_LONG, WEEK_ORDER, formatDate, formatTime } from '@/lib/format';
import { useClinicToday } from '@/lib/hooks';
import type { DoctorAvailability, Session, WeeklyHours } from '@/lib/types';

interface EditorProps {
  session: Session;
  availability: DoctorAvailability;
  onSaved: () => void;
}

type Feedback = { tone: 'success' | 'error'; message: string } | null;

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
      await api('/doctor-portal/availability/weekly', {
        method: 'PUT',
        token: session.accessToken,
        body: { hours: rows },
      });
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
          Patients book {availability.consultationMinutes}-minute slots inside these hours. Capacity is the maximum number of
          bookings per session.
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
