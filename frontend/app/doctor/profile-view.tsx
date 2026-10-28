'use client';

import { PageHeader } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { ProfileEditor } from './profile-editor';

export function DoctorProfilePage() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor/profile">
      {(session) => (
        <div className="animate-in fade-in-0 duration-300">
          <PageHeader title="Profile" description="What patients see about you on the doctor list and your booking page." />
          <ProfileEditor session={session} />
        </div>
      )}
    </RequireRole>
  );
}
