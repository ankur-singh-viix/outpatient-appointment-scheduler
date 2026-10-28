'use client';

import { Alert, PageHeader, Spinner } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import type { DoctorAvailability, Session } from '@/lib/types';
import { DateOverridesEditor, SlotLengthEditor, WeeklyHoursEditor } from './availability-editor';

export function DoctorAvailabilityPage() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor/availability">
      {(session) => <AvailabilityView session={session} />}
    </RequireRole>
  );
}

function AvailabilityView({ session }: { session: Session }) {
  const availability = useQuery(`availability:${session.user.id}`, () =>
    api<DoctorAvailability>('/doctor-portal/availability', { token: session.accessToken }),
  );

  const data = availability.data ?? availability.previous;
  return (
    <div className="animate-in fade-in-0 duration-300">
      <PageHeader title="Availability" description="Your weekly sessions, capacity, slot length and days off. Patients see changes straight away." />
      {availability.loading && !data && <Spinner label="Loading availability…" />}
      {availability.error && <Alert>{availability.error}</Alert>}
      {data && (
        <div className="space-y-6">
          {/* No keys on the editors: remounting after a save would wipe their "saved" messages. */}
          <SlotLengthEditor session={session} availability={data} onSaved={availability.reload} />
          <WeeklyHoursEditor session={session} availability={data} onSaved={availability.reload} />
          <DateOverridesEditor session={session} availability={data} onSaved={availability.reload} />
        </div>
      )}
    </div>
  );
}
