'use client';

import { CalendarDaysIcon, RepeatIcon, UserIcon, UsersIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { DAY_LONG, DAY_SHORT, WEEK_ORDER, formatDate, formatTimeRange } from '@/lib/format';
import { useClinicToday } from '@/lib/hooks';
import { restoredNote } from './restored-note';
import type { AvailabilityRow, DoctorAvailability, SchedulingMode, Session, WeeklyHours } from '@/lib/types';
import { cn } from '@/lib/utils';
import { SLOT_MINUTES, sessionBody, slotsInWindow, toMinutes } from './availability-model';
import { ChoiceCards } from './choice-cards';

type Kind = 'recurring' | 'oneoff';
type Feedback = { tone: 'error'; message: string } | null;

const selectClass =
  'h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * The one place a doctor adds availability, or edits a recurring session: pick the type (recurring or a single date), the
 * scheduling mode (Stream or Wave), the hours and slot settings, check the plain-language summary, and save. Keyed by the session
 * being edited by the parent, so each edit starts from that session's values.
 */
export function AvailabilityBuilder({
  session,
  availability,
  editing,
  prefillDate = null,
  onCancelEdit,
  onSaved,
}: {
  session: Session;
  availability: DoctorAvailability;
  /** A saved recurring session to change, or null to add a new one. */
  editing: WeeklyHours | null;
  /** Opens the form as a single-date session on this date (a new object each time it is asked for). */
  prefillDate?: { date: string; n: number } | null;
  onCancelEdit: () => void;
  /** Called after a save with a plain-language confirmation. The page shows it, so it survives this form being reset. */
  onSaved: (message: string) => void;
}) {
  const today = useClinicToday();
  const [kind, setKind] = useState<Kind>(prefillDate ? 'oneoff' : 'recurring');
  const [mode, setMode] = useState<SchedulingMode>(editing?.schedulingMode ?? 'STREAM');
  const [days, setDays] = useState<number[]>(editing ? [editing.dayOfWeek] : [1]);
  const [date, setDate] = useState(prefillDate?.date ?? '');
  const [startTime, setStartTime] = useState(editing?.startTime.slice(0, 5) ?? '09:00');
  const [endTime, setEndTime] = useState(editing?.endTime.slice(0, 5) ?? '13:00');
  const [slotMinutes, setSlotMinutes] = useState(editing?.slotDurationMinutes ?? availability.consultationMinutes);
  const [patients, setPatients] = useState(editing && editing.schedulingMode === 'WAVE' ? editing.capacityPerSlot : availability.suggestedCapacityPerSlot);
  const [sessionCap, setSessionCap] = useState<number | null>(editing?.capacity ?? null);
  const [from, setFrom] = useState(editing?.effectiveFrom ?? '');
  const [to, setTo] = useState(editing?.effectiveTo ?? '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const recurring = kind === 'recurring';
  const wave = mode === 'WAVE';
  const lengths = SLOT_MINUTES.includes(slotMinutes) ? SLOT_MINUTES : [...SLOT_MINUTES, slotMinutes].sort((a, b) => a - b);
  const slots = slotsInWindow(startTime, endTime, slotMinutes);

  const problem = (() => {
    if (recurring && days.length === 0) return 'Pick at least one day.';
    if (!recurring && !date) return 'Pick a date.';
    if (!startTime || !endTime) return 'Set a start and an end time.';
    if (toMinutes(endTime) <= toMinutes(startTime)) return 'The end time must be after the start time.';
    if (slots < 1) return `The hours must be at least ${slotMinutes} minutes long to fit one slot.`;
    if (wave && (!Number.isInteger(patients) || patients < 1 || patients > 100)) return 'Patients per slot must be a whole number from 1 to 100.';
    if (!wave && sessionCap !== null && (!Number.isInteger(sessionCap) || sessionCap < 1 || sessionCap > 200)) return 'The booking cap must be a whole number from 1 to 200.';
    if (recurring && from && to && to < from) return 'The end date must not be before the start date.';
    return null;
  })();

  const row: AvailabilityRow = {
    startTime,
    endTime,
    schedulingMode: mode,
    slotDurationMinutes: slotMinutes,
    capacityPerSlot: wave ? patients : 1,
    capacity: wave ? null : sessionCap,
    effectiveFrom: recurring && from ? from : null,
    effectiveTo: recurring && to ? to : null,
  };

  const toggleDay = (day: number) =>
    setDays((current) => (editing ? [day] : current.includes(day) ? current.filter((entry) => entry !== day) : [...current, day]));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    setBusy(true);
    setFeedback(null);
    const minutes = availability.consultationMinutes;
    try {
      if (!recurring) {
        const added = await api<{ restoredAppointments?: number }>('/doctor-portal/availability/one-time', { method: 'POST', token: session.accessToken, body: { date, ...sessionBody(row, minutes) } });
        onSaved(`Added a ${wave ? 'Wave' : 'Stream'} session on ${formatDate(date, { weekday: 'long' })}. Patients can book it now.${restoredNote(added.restoredAppointments)}`);
      } else {
        const weekly: (AvailabilityRow & { dayOfWeek: number })[] = editing
          ? availability.weekly.map((existing) => (existing.id === editing.id ? { ...row, dayOfWeek: days[0] } : existing))
          : [...availability.weekly, ...days.map((day) => ({ ...row, dayOfWeek: day }))];
        const saved = await api<{ restoredAppointments?: number }>('/doctor-portal/availability/weekly', {
          method: 'PUT',
          token: session.accessToken,
          body: { hours: weekly.map((entry) => ({ dayOfWeek: entry.dayOfWeek, ...sessionBody(entry, minutes) })) },
        });
        onSaved(editing ? 'Saved your changes. Patients now see the updated slots.' : `Added ${days.length === 1 ? 'the session' : `${days.length} sessions`}. Patients can book them now.${restoredNote(saved.restoredAppointments)}`);
        if (editing) onCancelEdit();
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const daysText = WEEK_ORDER.filter((day) => days.includes(day))
    .map((day) => DAY_LONG[day])
    .join(', ');
  const hoursText = startTime && endTime ? formatTimeRange(startTime, endTime) : 'choose the hours';
  const modeText = wave ? `Wave: up to ${patients || '…'} patients share each ${slotMinutes}-minute slot` : `Stream: one patient per ${slotMinutes}-minute slot`;
  const range = from || to ? `${from ? `from ${formatDate(from)}` : 'from today'}${to ? ` until ${formatDate(to)}` : ', with no end date'}` : 'every week, with no end date';

  return (
    <Card className="[--card-spacing:--spacing(6)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          {editing ? `Edit ${DAY_LONG[editing.dayOfWeek]} session` : 'Add availability'}
        </CardTitle>
        <CardDescription>
          Choose when patients can book you and how each slot works. Patients see changes straight away; appointments already booked are never moved.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-6" noValidate>
          {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}

          <ChoiceCards<Kind>
            legend="Availability type"
            name="availability-kind"
            value={kind}
            onChange={setKind}
            disabled={editing !== null}
            choices={[
              { value: 'recurring', title: 'Recurring', description: 'Repeats every week on the days you pick, until you remove it.', icon: RepeatIcon },
              { value: 'oneoff', title: 'Non-recurring', description: 'One specific date only, such as an extra clinic.', icon: CalendarDaysIcon },
            ]}
          />

          <ChoiceCards<SchedulingMode>
            legend="Scheduling mode"
            name="availability-mode"
            value={mode}
            onChange={setMode}
            choices={[
              { value: 'STREAM', title: 'Stream', description: 'One patient per slot. Every patient gets an exact time.', icon: UserIcon },
              { value: 'WAVE', title: 'Wave', description: 'Several patients share a slot, up to a limit you set. Absorbs no-shows.', icon: UsersIcon },
            ]}
          />

          <div className="space-y-5 rounded-xl bg-muted/60 p-4 sm:p-5">
            {recurring ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{editing ? 'Day' : 'Days of the week'}</legend>
                <div className="flex flex-wrap gap-2">
                  {WEEK_ORDER.map((day) => {
                    const on = days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        title={DAY_LONG[day]}
                        onClick={() => toggleDay(day)}
                        className={cn(
                          'h-10 min-w-12 rounded-full border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                          on ? 'border-primary bg-primary text-primary-foreground shadow-xs' : 'border-border bg-card text-foreground hover:border-primary/50 hover:bg-accent/40',
                        )}
                      >
                        {DAY_SHORT[day]}
                      </button>
                    );
                  })}
                </div>
                {!editing && <p className="text-xs text-muted-foreground">Pick several days to add the same hours to each of them.</p>}
              </fieldset>
            ) : (
              <div className="space-y-2 sm:max-w-xs">
                <Label htmlFor="avail-date">Date</Label>
                <Input id="avail-date" type="date" required min={today ?? undefined} value={date} onChange={(e) => setDate(e.target.value)} className="h-10 bg-card" />
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="avail-start">Start time</Label>
                <Input id="avail-start" type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={editing !== null} className="h-10 bg-card" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="avail-end">End time</Label>
                <Input id="avail-end" type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={editing !== null} className="h-10 bg-card" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="avail-slot">Slot duration</Label>
                <select id="avail-slot" value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))} className={selectClass}>
                  {lengths.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes} minutes
                    </option>
                  ))}
                </select>
              </div>
              {wave ? (
                <div className="space-y-2">
                  <Label htmlFor="avail-patients">Patients per slot</Label>
                  <Input id="avail-patients" type="number" min={1} max={100} required value={patients} onChange={(e) => setPatients(Number(e.target.value))} className="h-10 bg-card" />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="avail-cap">Booking cap (optional)</Label>
                  <Input
                    id="avail-cap"
                    type="number"
                    min={1}
                    max={200}
                    placeholder={`${availability.defaultCapacity}`}
                    value={sessionCap ?? ''}
                    onChange={(e) => setSessionCap(e.target.value === '' ? null : Number(e.target.value))}
                    aria-describedby="avail-cap-hint"
                    className="h-10 bg-card"
                  />
                </div>
              )}
            </div>
            {editing && (
              <p className="-mt-2 text-xs text-muted-foreground">
                The hours are locked here. To change them, use “Adjust hours” on the session: it shows the effect first and leaves existing slots and appointments as they are.
              </p>
            )}
            {!wave && (
              <p id="avail-cap-hint" className="-mt-2 text-xs text-muted-foreground">
                Stream always takes one patient per slot. The booking cap limits how many bookings the whole session takes; leave it empty to use your default ({availability.defaultCapacity}).
              </p>
            )}

            {recurring && (
              <div className="grid gap-4 sm:grid-cols-2 sm:max-w-xl">
                <div className="space-y-2">
                  <Label htmlFor="avail-from">Effective from (optional)</Label>
                  <Input id="avail-from" type="date" min={today ?? undefined} value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 bg-card" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="avail-to">Effective until (optional)</Label>
                  <Input id="avail-to" type="date" min={from || (today ?? undefined)} value={to} onChange={(e) => setTo(e.target.value)} className="h-10 bg-card" />
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-primary/25 bg-accent/40 p-4 text-sm" aria-live="polite">
            <p className="font-semibold text-foreground">Summary</p>
            <p className="mt-1 text-foreground/90">
              {recurring ? `${daysText || 'No day chosen'} · ${hoursText} · ${range}` : `${date ? formatDate(date, { weekday: 'long' }) : 'No date chosen'} · ${hoursText}`}
            </p>
            <p className="text-muted-foreground">{modeText}</p>
            {slots > 0 && (
              <p className="text-muted-foreground">
                {slots} slot{slots === 1 ? '' : 's'} {recurring ? 'a day' : 'on this date'}
                {wave && patients > 0 ? `, up to ${slots * patients} patients` : ''}.
              </p>
            )}
            {problem && (
              <p className="mt-2 font-medium text-amber-800" role="alert">
                {problem}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="lg" disabled={busy || problem !== null} className="h-10 px-5">
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add availability'}
            </Button>
            {editing && (
              <Button type="button" variant="outline" size="lg" className="h-10" onClick={onCancelEdit} disabled={busy}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
