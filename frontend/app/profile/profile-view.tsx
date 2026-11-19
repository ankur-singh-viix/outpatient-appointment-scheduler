'use client';

import { useState } from 'react';
import { LogOutIcon } from 'lucide-react';
import { Alert, Avatar, Spinner } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate, initials } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { signOutEverywhere } from '@/lib/session';
import type { PatientProfile, Session } from '@/lib/types';
import { MedicalProfileForm } from './medical-profile-form';

export function ProfileView() {
  return (
    <RequireRole role="PATIENT" nextPath="/profile">
      {(session) => <Profile session={session} />}
    </RequireRole>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words text-foreground">{children}</dd>
    </div>
  );
}

const NOT_GIVEN = <span className="font-normal text-muted-foreground">Not provided</span>;

function Profile({ session }: { session: Session }) {
  const profile = useQuery(`profile:${session.user.id}`, () => api<PatientProfile>('/auth/me/profile', { token: session.accessToken }));
  const [override, setOverride] = useState<PatientProfile | null>(null);
  if (profile.loading && !profile.data && !override) return <Spinner label="Loading your profile…" />;
  if ((profile.error || !profile.data) && !override) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={profile.reload}>
            Try again
          </Button>
        }
      >
        Could not load your profile. {profile.error}
      </Alert>
    );
  }
  const p = override ?? profile.data!;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card className="[--card-spacing:--spacing(6)]">
        <CardContent className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Avatar text={initials(p.name)} />
          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold text-foreground">{p.name}</p>
            <p className="text-sm break-all text-muted-foreground">{p.email}</p>
            <p className="mt-2 font-mono text-sm font-semibold tracking-wide text-teal-800 tabular-nums">{p.uhid}</p>
            <p className="mt-1 text-xs text-muted-foreground">Patient since {formatDate(p.memberSince.slice(0, 10), { weekday: undefined })}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle as="h2" className="text-lg font-semibold">
            Your details
          </CardTitle>
          <CardDescription>Account and contact information. Your permanent patient ID is shown above.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Field label="UHID">
              <span className="font-mono tabular-nums">{p.uhid}</span>
            </Field>
            <Field label="Full name">{p.name}</Field>
            <Field label="Email">{p.email}</Field>
            <Field label="Phone">{p.phone ?? NOT_GIVEN}</Field>
            <Field label="Date of birth">{p.dateOfBirth ? formatDate(p.dateOfBirth, { weekday: undefined }) : NOT_GIVEN}</Field>
            <Field label="Gender">{p.gender ?? NOT_GIVEN}</Field>
            <Field label="Address">{p.address ?? NOT_GIVEN}</Field>
          </dl>
          <p className="border-t pt-4 text-sm text-muted-foreground">
            Contact details are shown for your information. Changing name, email or phone online is not available yet.
          </p>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle as="h2" className="text-lg font-semibold">
            Medical information
          </CardTitle>
          <CardDescription>Only you can view and update this. Front desk staff cannot see these details.</CardDescription>
        </CardHeader>
        <CardContent>
          <MedicalProfileForm
            session={session}
            profile={p}
            onSaved={(next) => {
              setOverride(next);
              profile.reload();
            }}
          />
        </CardContent>
      </Card>

      <Button variant="outline" size="lg" className="h-10 gap-2" onClick={() => void signOutEverywhere()}>
        <LogOutIcon aria-hidden />
        Sign out
      </Button>
    </div>
  );
}
