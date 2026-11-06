'use client';

import { CalendarIcon } from 'lucide-react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { addDays, formatDate, formatTime, formatTimeRange } from '@/lib/format';
import { useAutoRefresh, useClinicToday, useQuery } from '@/lib/hooks';
import { SLOT_CHIP_STYLES, slotStatusText } from '@/lib/slot-display';
import type { DaySchedule, ReceptionDoctor, SessionSummary, Slot } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ModeBadge } from '../doctor/availability-list';

const BOOKING_DAYS = 30;

/** The slots belonging to one session (sessions can overlap in time, so the session an availability row came from matters). */
const slotsOf = (session: SessionSummary, slots: Slot[]) =>
  slots.filter((slot) => slot.startTime >= session.startTime && slot.startTime < session.endTime && (slot.availabilityId ?? null) === (session.availabilityId ?? null));

/**
 * A date and the doctor's slots on it, as the server offers them right now (the same answer patients get, refreshed every few
 * seconds so places taken elsewhere show up). Stream slots are one patient each; Wave slots show the places left. Only open slots
 * can be chosen: the server still checks again when the booking is made.
 */
export function SlotPicker({
  doctor,
  date,
  onDateChange,
  selected,
  onSelect,
  version = 0,
}: {
  doctor: ReceptionDoctor;
  date: string;
  onDateChange: (date: string) => void;
  selected: Slot | null;
  onSelect: (slot: Slot | null) => void;
  /** Bumped by the parent after a change, to fetch again at once. */
  version?: number;
}) {
  const today = useClinicToday();
  const schedule = useQuery(date ? `reception-slots:${doctor.id}:${date}:${version}` : null, () => api<DaySchedule>(`/doctors/${doctor.id}/slots?date=${date}`));
  useAutoRefresh(() => {
    if (date) schedule.reload();
  }, 15_000);

  const data = schedule.data ?? schedule.previous;
  const slots = data?.slots ?? [];
  const open = slots.filter((slot) => slot.status === 'AVAILABLE').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor={`slot-date-${doctor.id}`}>Date</Label>
          <Input
            id={`slot-date-${doctor.id}`}
            type="date"
            min={today ?? undefined}
            max={today ? addDays(today, BOOKING_DAYS - 1) : undefined}
            value={date}
            onChange={(event) => {
              onDateChange(event.target.value);
              onSelect(null);
            }}
            className="h-10 w-44 bg-card"
          />
        </div>
        {today && (
          <div className="flex gap-2 pb-0.5">
            {[
              ['Today', today],
              ['Tomorrow', addDays(today, 1)],
            ].map(([label, value]) => (
              <Button
                key={label}
                type="button"
                variant={date === value ? 'default' : 'outline'}
                size="sm"
                className="h-9"
                onClick={() => {
                  onDateChange(value);
                  onSelect(null);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
      </div>

      {schedule.error && (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={schedule.reload}>
              Try again
            </Button>
          }
        >
          Could not load the slots. {schedule.error}
        </Alert>
      )}
      {schedule.loading && !data && <Spinner label="Loading slots…" />}

      {data && slots.length === 0 && (
        <EmptyState title="No slots on this date" icon={CalendarIcon}>
          {data.unavailableReason ?? `${doctor.name} has no availability on ${formatDate(date, { weekday: 'long' })}.`} Choose another date.
        </EmptyState>
      )}

      {data && slots.length > 0 && (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {open === 0 ? 'Every slot on this date is taken or has passed.' : `${open} of ${slots.length} slots open on ${formatDate(date, { weekday: 'long' })}.`} Updates automatically.
          </p>
          {data.sessions.map((session, index) => {
            const sessionSlots = slotsOf(session, slots);
            if (sessionSlots.length === 0) return null;
            const wave = session.mode === 'WAVE';
            return (
              <section key={`${session.availabilityId ?? 'exception'}:${session.startTime}:${index}`} className="space-y-2" aria-label={`Session ${formatTimeRange(session.startTime, session.endTime)}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <h3 className="flex items-center gap-2 font-semibold text-foreground">
                    {formatTime(session.startTime)}–{formatTime(session.endTime)}
                    <ModeBadge mode={session.mode ?? 'STREAM'} />
                  </h3>
                  <span className="text-muted-foreground">
                    {wave ? `${session.slotMinutes ?? ''}-minute slots · up to ${session.capacityPerSlot} patients each` : `${session.slotMinutes ?? ''}-minute slots · one patient per slot`}
                  </span>
                </div>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {sessionSlots.map((slot) => {
                    const isSelected = selected?.startTime === slot.startTime;
                    const bookable = slot.status === 'AVAILABLE';
                    return (
                      <li key={slot.startTime}>
                        <button
                          type="button"
                          disabled={!bookable}
                          aria-pressed={isSelected}
                          onClick={() => onSelect(isSelected ? null : slot)}
                          className={cn(
                            'flex h-14 w-full flex-col items-center justify-center rounded-lg border text-xs font-semibold transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed',
                            isSelected ? 'border-primary bg-primary text-primary-foreground shadow-sm' : SLOT_CHIP_STYLES[slot.status],
                          )}
                        >
                          <span className={cn(slot.status === 'BOOKED' && 'line-through')}>{formatTimeRange(slot.startTime, slot.endTime, true)}</span>
                          <span className="text-[11px] font-medium">{isSelected ? 'Selected' : slotStatusText(slot, session.mode ?? 'STREAM', session.capacityPerSlot ?? 1)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
