"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatTimeRange } from "@/lib/format";
import { useClinicToday } from "@/lib/hooks";
import type {
  AvailabilityRow,
  DoctorAvailability,
  SchedulingMode,
  Session,
} from "@/lib/types";

export const selectClass =
  "h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const SLOT_MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const DEFAULT_WAVE_PLACES = 3;

/** The part of an availability row that says how its hours are cut into slots. */
export type SessionSettings = Pick<
  AvailabilityRow,
  "schedulingMode" | "slotDurationMinutes" | "capacityPerSlot" | "capacity"
>;

/** The settings for a plain new session: STREAM, the doctor's appointment length, one patient per slot. */
export function plainSettings(consultationMinutes: number): SessionSettings {
  return {
    schedulingMode: "STREAM",
    slotDurationMinutes: consultationMinutes,
    capacityPerSlot: 1,
    capacity: null,
  };
}

/** One line for a session's settings, e.g. "Wave · 30-minute slots · up to 3 patients each". */
export function describeSettings(
  row: SessionSettings,
  fallbackMinutes: number,
): string {
  const length = `${row.slotDurationMinutes ?? fallbackMinutes}-minute slots`;
  return row.schedulingMode === "WAVE"
    ? `Wave · ${length} · up to ${row.capacityPerSlot} patients each`
    : `Stream · ${length} · one patient per slot${row.capacity ? ` · max ${row.capacity} bookings` : ""}`;
}

/**
 * The request body for a session, with every field spelled out. Only the fields the server expects are sent (a row read from the
 * API also carries an id and empty dates), and STREAM always sends one patient per slot.
 */
export function sessionBody(row: AvailabilityRow, fallbackMinutes: number) {
  const wave = row.schedulingMode === "WAVE";
  return {
    startTime: row.startTime,
    endTime: row.endTime,
    schedulingMode: row.schedulingMode,
    slotDurationMinutes: row.slotDurationMinutes ?? fallbackMinutes,
    capacityPerSlot: wave ? row.capacityPerSlot : 1,
    ...(!wave && row.capacity !== null && { capacity: row.capacity }),
    ...(row.effectiveFrom && { effectiveFrom: row.effectiveFrom }),
    ...(row.effectiveTo && { effectiveTo: row.effectiveTo }),
  };
}

/**
 * Mode, slot length and capacity for one session. Wave takes several patients per slot; Stream takes exactly one (so there is
 * nothing to set for it besides an optional cap on the whole session, which is how sessions have always worked).
 */
export function SessionFields({
  label,
  value,
  onChange,
  fallbackMinutes,
  defaultCapacity,
}: {
  /** Names the fields for screen readers, e.g. "Monday session 1". */
  label: string;
  value: SessionSettings;
  onChange: (patch: Partial<SessionSettings>) => void;
  fallbackMinutes: number;
  defaultCapacity: number;
}) {
  const wave = value.schedulingMode === "WAVE";
  const minutes = value.slotDurationMinutes ?? fallbackMinutes;
  const lengths = SLOT_MINUTES.includes(minutes)
    ? SLOT_MINUTES
    : [...SLOT_MINUTES, minutes].sort((a, b) => a - b);

  const changeMode = (mode: SchedulingMode) =>
    onChange(
      mode === "WAVE"
        ? {
            schedulingMode: "WAVE",
            capacityPerSlot:
              value.capacityPerSlot > 1
                ? value.capacityPerSlot
                : DEFAULT_WAVE_PLACES,
            capacity: null,
          }
        : { schedulingMode: "STREAM", capacityPerSlot: 1 },
    );

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-xs text-muted-foreground">
        Scheduling
        <select
          aria-label={`${label} scheduling mode`}
          value={value.schedulingMode}
          onChange={(e) => changeMode(e.target.value as SchedulingMode)}
          className={`${selectClass} w-44 text-foreground`}
        >
          <option value="STREAM">Stream (one per slot)</option>
          <option value="WAVE">Wave (several per slot)</option>
        </select>
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        Slot length
        <select
          aria-label={`${label} slot length`}
          value={minutes}
          onChange={(e) =>
            onChange({ slotDurationMinutes: Number(e.target.value) })
          }
          className={`${selectClass} w-32 text-foreground`}
        >
          {lengths.map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </label>
      {wave ? (
        <label className="space-y-1 text-xs text-muted-foreground">
          Patients per slot
          <Input
            type="number"
            min={1}
            max={100}
            aria-label={`${label} patients per slot`}
            value={value.capacityPerSlot}
            onChange={(e) =>
              onChange({ capacityPerSlot: Number(e.target.value) })
            }
            className="h-9 w-24 text-foreground"
          />
        </label>
      ) : (
        <>
          <p className="pb-2 text-sm text-muted-foreground">
            1 patient per slot
          </p>
          <label className="space-y-1 text-xs text-muted-foreground">
            Max bookings in session (optional)
            <Input
              type="number"
              min={1}
              max={200}
              aria-label={`${label} maximum bookings in the session`}
              placeholder={String(defaultCapacity)}
              value={value.capacity ?? ""}
              onChange={(e) =>
                onChange({
                  capacity:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className="h-9 w-28 text-foreground"
            />
          </label>
        </>
      )}
    </div>
  );
}

type Feedback = { tone: "success" | "error"; message: string } | null;

/** Adds sessions for one specific date. They take priority over the weekly hours for the time they overlap. */
export function OneTimeSessionsEditor({
  session,
  availability,
  onSaved,
}: {
  session: Session;
  availability: DoctorAvailability;
  onSaved: () => void;
}) {
  const today = useClinicToday();
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("14:00");
  const [endTime, setEndTime] = useState("17:00");
  const [settings, setSettings] = useState<SessionSettings>(
    plainSettings(availability.consultationMinutes),
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      await work();
      setFeedback({ tone: "success", message: success });
      onSaved();
    } catch (error) {
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = {
      date,
      ...sessionBody(
        {
          ...settings,
          startTime,
          endTime,
          effectiveFrom: null,
          effectiveTo: null,
        },
        availability.consultationMinutes,
      ),
    };
    void run(
      () =>
        api("/doctor-portal/availability/one-time", {
          method: "POST",
          token: session.accessToken,
          body,
        }),
      `Added a session on ${formatDate(date)}.`,
    );
  };

  const remove = (id: string, when: string) =>
    run(
      () =>
        api(`/doctor-portal/availability/one-time/${id}`, {
          method: "DELETE",
          token: session.accessToken,
        }),
      `Removed the session on ${formatDate(when)}.`,
    );

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          One-time sessions
        </CardTitle>
        <CardDescription>
          Add hours for one specific date, for example an extra clinic. Where
          they overlap your weekly hours they win; your weekly hours still apply
          outside them. A date exception below replaces the whole day, including
          these.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}

        <form onSubmit={submit} className="space-y-4 rounded-lg bg-muted p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="one-time-date">Date</Label>
              <Input
                id="one-time-date"
                type="date"
                required
                min={today ?? undefined}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9 bg-card"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="one-time-from">From</Label>
              <Input
                id="one-time-from"
                type="time"
                required
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="h-9 w-32 bg-card"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="one-time-to">To</Label>
              <Input
                id="one-time-to"
                type="time"
                required
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="h-9 w-32 bg-card"
              />
            </div>
          </div>
          <SessionFields
            label="One-time session"
            value={settings}
            onChange={(patch) =>
              setSettings((current) => ({ ...current, ...patch }))
            }
            fallbackMinutes={availability.consultationMinutes}
            defaultCapacity={availability.defaultCapacity}
          />
          <Button type="submit" size="lg" disabled={busy || !date}>
            {busy ? "Saving…" : "Add one-time session"}
          </Button>
        </form>

        {availability.oneTime.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming one-time sessions.
          </p>
        ) : (
          <ul className="divide-y" aria-label="Upcoming one-time sessions">
            {availability.oneTime.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
              >
                <div>
                  <p className="font-semibold text-foreground">
                    {formatDate(row.date, { weekday: "long" })} ·{" "}
                    {formatTimeRange(row.startTime, row.endTime)}
                  </p>
                  <p className="text-muted-foreground">
                    {describeSettings(row, availability.consultationMinutes)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => row.id && remove(row.id, row.date)}
                >
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
