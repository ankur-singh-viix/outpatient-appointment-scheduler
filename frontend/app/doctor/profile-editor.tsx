'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Spinner } from '@/components/common';
import { Field, controlClass, fieldProps } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import type { Clinic, DoctorProfile, Session, Specialty } from '@/lib/types';
import { cn } from '@/lib/utils';
import { fieldErrorsFromApi, without, type Errors } from '@/lib/validation';

/** The doctor's public profile: what patients see on the directory card and the booking page. */
export function ProfileEditor({ session }: { session: Session }) {
  const profile = useQuery(`doctor-profile:${session.user.id}`, () =>
    api<DoctorProfile>('/doctor-portal/profile', { token: session.accessToken }),
  );
  const specialties = useQuery('specialties', () => api<Specialty[]>('/specialties'));
  const clinics = useQuery('clinics', () => api<Clinic[]>('/clinics'));

  const data = profile.data ?? profile.previous;
  if (!data && profile.loading) return <Spinner label="Loading your profile…" />;
  if (profile.error || !data) {
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
  return (
    <ProfileForm
      session={session}
      initial={data}
      specialties={specialties.data ?? []}
      clinics={clinics.data ?? []}
      listsLoading={specialties.loading || clinics.loading}
      onSaved={profile.reload}
    />
  );
}

function ProfileForm({
  session,
  initial,
  specialties,
  clinics,
  listsLoading,
  onSaved,
}: {
  session: Session;
  initial: DoctorProfile;
  specialties: Specialty[];
  clinics: Clinic[];
  listsLoading: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [specialtyId, setSpecialtyId] = useState(initial.specialtyId);
  const [clinicId, setClinicId] = useState(initial.clinicId);
  const [fee, setFee] = useState(String(initial.consultationFee));
  const [bio, setBio] = useState(initial.bio ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const clear = (field: string) => setErrors((current) => without(current, field));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    const found: Errors = {};
    if (name.trim().length < 2) found.name = 'Enter your name (at least 2 characters).';
    else if (name.trim().length > 100) found.name = 'Use 100 characters or fewer.';
    if (!/^\d+$/.test(fee.trim())) found.consultationFee = 'Use whole rupees only, with no symbols.';
    else if (Number(fee) > 100000) found.consultationFee = 'That fee looks too high. Use ₹100,000 or less.';
    if (bio.length > 1000) found.bio = 'Keep your bio to 1000 characters or fewer.';
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    try {
      await api('/doctor-portal/profile', {
        method: 'PUT',
        token: session.accessToken,
        body: { name: name.trim(), specialtyId, clinicId, consultationFee: Number(fee), bio: bio.trim() || null },
      });
      setFeedback({ tone: 'success', message: 'Profile saved. Patients see the update straight away.' });
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        const fromServer = fieldErrorsFromApi(error.details);
        setErrors(fromServer);
        if (!Object.keys(fromServer).length) setFeedback({ tone: 'error', message: error.message });
      } else {
        setFeedback({ tone: 'error', message: errorMessage(error) });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <form onSubmit={submit} noValidate className="contents">
        <CardHeader>
          <CardTitle as="h2" className="text-lg font-semibold">
            Your public profile
          </CardTitle>
          <CardDescription>
            This is what patients see on the doctor list and your booking page. Your sign-in email is{' '}
            <span className="font-medium text-foreground">{initial.email}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {feedback && <Alert tone={feedback.tone}>{feedback.message}</Alert>}

          <Field id="profile-name" label="Name" error={errors.name} hint="“Dr.” is added automatically.">
            <Input {...fieldProps('profile-name', errors.name, 'hint')} value={name} onChange={(e) => { setName(e.target.value); clear('name'); }} className="h-10" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="profile-specialty" label="Specialty" error={errors.specialtyId}>
              <select
                {...fieldProps('profile-specialty', errors.specialtyId)}
                value={specialtyId}
                onChange={(e) => setSpecialtyId(e.target.value)}
                disabled={listsLoading}
                className={cn(controlClass, 'h-10')}
              >
                {specialties.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="profile-clinic"
              label="Clinic"
              error={errors.clinicId}
              hint="You can move clinic only when you have no upcoming appointments."
            >
              <select
                {...fieldProps('profile-clinic', errors.clinicId, 'hint')}
                value={clinicId}
                onChange={(e) => setClinicId(e.target.value)}
                disabled={listsLoading}
                className={cn(controlClass, 'h-10')}
              >
                {clinics.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.address}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field id="profile-fee" label="Consultation fee (₹)" error={errors.consultationFee} hint="Whole rupees. Patients pay at the clinic.">
            <Input
              {...fieldProps('profile-fee', errors.consultationFee, 'hint')}
              inputMode="numeric"
              value={fee}
              onChange={(e) => {
                setFee(e.target.value);
                clear('consultationFee');
              }}
              className="h-10 sm:w-48"
            />
          </Field>
          <Field id="profile-bio" label="Bio" optional error={errors.bio} hint={`${bio.length}/1000. Qualifications and experience help patients choose.`}>
            <textarea
              {...fieldProps('profile-bio', errors.bio, 'hint')}
              rows={5}
              maxLength={1000}
              value={bio}
              onChange={(e) => {
                setBio(e.target.value);
                clear('bio');
              }}
              className={cn(controlClass, 'min-h-28 py-2')}
            />
          </Field>
          <Button type="submit" size="lg" disabled={saving} className="h-10">
            {saving ? 'Saving…' : 'Save profile'}
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}
