'use client';

import { InfoIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, PageHeader, Spinner } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import type { DoctorAvailability, Session, WeeklyHours } from '@/lib/types';
import { AvailabilityBuilder } from './availability-builder';
import { DateOverridesEditor, SlotLengthEditor } from './availability-editor';
import { AvailabilityList } from './availability-list';
import { OutsideHoursCard } from './outside-hours-card';
import { UpcomingScheduleCard } from './upcoming-schedule';

export function DoctorAvailabilityPage() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor/availability">
      {(session) => <AvailabilityView session={session} />}
    </RequireRole>
  );
}

function HowItWorks() {
  return (
    <details className="group rounded-xl border bg-card shadow-xs">
      <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <InfoIcon className="size-4 text-primary" aria-hidden />
        How availability works
        <span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">Show</span>
      </summary>
      <div className="grid gap-4 border-t px-4 py-4 text-sm text-muted-foreground sm:grid-cols-2">
        <div className="space-y-1">
          <p className="font-semibold text-foreground">Recurring or non-recurring</p>
          <p>
            <span className="font-medium text-foreground">Recurring</span> hours repeat every week on the days you choose, optionally between two dates.{' '}
            <span className="font-medium text-foreground">Non-recurring</span> hours apply to one date only. Where a single date overlaps your weekly hours, the single date wins for that time.
          </p>
        </div>
        <div className="space-y-1">
          <p className="font-semibold text-foreground">Stream or Wave</p>
          <p>
            <span className="font-medium text-foreground">Stream</span> gives every slot exactly one patient, so each has an exact time.{' '}
            <span className="font-medium text-foreground">Wave</span> lets several patients share a slot, up to the number you set; each slot is counted on its own, which absorbs no-shows.
          </p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <p className="font-semibold text-foreground">Days off and date exceptions</p>
          <p>
            A date exception (below) can take a whole day off, block part of a day, or replace the hours on a date. Appointments already booked on that date are not moved or cancelled; they appear under
            Appointments outside your hours, where you can ask each patient to choose a new time.
          </p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <p className="font-semibold text-foreground">Reducing your hours</p>
          <p>
            Use Adjust hours on a session to shorten it. You see which booked appointments would fall outside the new hours before anything is saved. Those appointments stay booked: nothing is moved or
            cancelled automatically. Each affected patient is emailed and asked to choose a new time, and an appointment moves only after its patient confirms the new time. If no other time is open for a
            patient, you can add a one-time session for them. Cancelling is the last resort, from Appointments outside your hours, with the usual notice and refund.
          </p>
        </div>
      </div>
    </details>
  );
}

function AvailabilityView({ session }: { session: Session }) {
  const availability = useQuery(`availability:${session.user.id}`, () =>
    api<DoctorAvailability>('/doctor-portal/availability', { token: session.accessToken }),
  );
  const [editing, setEditing] = useState<WeeklyHours | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // "Add a one-time session" from the list of appointments outside the hours: the form opens on that date.
  const [prefill, setPrefill] = useState<{ date: string; n: number } | null>(null);
  // Bumped after any change, so the upcoming schedule (which has its own query) fetches again.
  const [version, setVersion] = useState(0);
  const refresh = () => {
    availability.reload();
    setVersion((current) => current + 1);
  };

  const data = availability.data ?? availability.previous;
  return (
    <div className="animate-in fade-in-0 space-y-6 duration-300">
      <PageHeader title="Availability" description="Decide when patients can book you, and how each slot works. Patients see changes straight away." />
      {availability.loading && !data && <Spinner label="Loading availability…" />}
      {availability.error && <Alert>{availability.error}</Alert>}
      {data && (
        <>
          <HowItWorks />
          {notice && <Alert tone="success">{notice}</Alert>}
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            {/* Keyed by the session being edited: each edit starts from that session's values, and adding starts clean. */}
            <AvailabilityBuilder
              key={`${editing?.id ?? 'new'}:${prefill?.n ?? 0}`}
              session={session}
              availability={data}
              editing={editing}
              prefillDate={prefill}
              onCancelEdit={() => setEditing(null)}
              onSaved={(message) => {
                setNotice(message);
                refresh();
              }}
            />
            <AvailabilityList
              session={session}
              availability={data}
              editingId={editing?.id ?? null}
              onEdit={(row) => {
                setEditing(row);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onChanged={() => {
                setEditing(null);
                refresh();
              }}
            />
          </div>
          <OutsideHoursCard
            session={session}
            version={version}
            onChanged={refresh}
            onAddSession={(date) => {
              setEditing(null);
              setPrefill((current) => ({ date, n: (current?.n ?? 0) + 1 }));
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
          <UpcomingScheduleCard session={session} version={version} onChanged={availability.reload} />
          {/* No keys on the editors: remounting after a save would wipe their "saved" messages. */}
          <DateOverridesEditor session={session} availability={data} onSaved={refresh} />
          <SlotLengthEditor session={session} availability={data} onSaved={refresh} />
        </>
      )}
    </div>
  );
}
