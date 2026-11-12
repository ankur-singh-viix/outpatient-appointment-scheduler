'use client';

import { ArrowLeftIcon, StethoscopeIcon, UserRoundIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { Field, controlClass, fieldProps } from '@/components/form-field';
import { SIGNUP_STEPS, Stepper } from '@/components/stepper';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useClinicToday, useQuery } from '@/lib/hooks';
import { LinkAccountPanel } from '@/components/link-account-panel';
import { setClerkState, useClerkState } from '@/lib/clerk-state';
import { saveSession, useAuthState, useHydrated } from '@/lib/session';
import { saveSignupDraft, useSignupDraft } from '@/lib/signup-draft';
import type { Clinic, PublicUser, Session, Specialty } from '@/lib/types';
import { ContinueRedirect } from '../continue/continue-redirect';
import { fieldErrorsFromApi, validateDoctor, validatePatient, without, type Errors } from '@/lib/validation';
import { cn } from '@/lib/utils';

type Role = 'PATIENT' | 'DOCTOR';

const ROLE_OPTIONS: { role: Role; title: string; text: string; icon: typeof UserRoundIcon }[] = [
  { role: 'PATIENT', title: "I'm a patient", text: 'Find doctors, book visits and manage your appointments.', icon: UserRoundIcon },
  { role: 'DOCTOR', title: "I'm a doctor", text: 'Share your availability and manage the appointments booked with you.', icon: StethoscopeIcon },
];

const EMPTY = { firstName: '', lastName: '', phone: '', dateOfBirth: '', gender: '', specialtyId: '', clinicId: '', fee: '', bio: '' };

export function OnboardingForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const draft = useSignupDraft();
  const authState = useAuthState();
  const clerk = useClerkState();
  // Signed in with Clerk and no CareSlot account yet: the profile is created for that Clerk sign-in. Otherwise this is the
  // legacy email-code sign-up, continued from its sign-up token.
  const clerkMode = authState === 'needs-profile';
  const signupEmail = clerkMode ? (clerk.account?.state === 'ONBOARDING_REQUIRED' ? clerk.account.email : '') : draft?.email;
  const today = useClinicToday();
  const [role, setRole] = useState<Role | null>(null);
  const [step, setStep] = useState<'role' | 'details'>('role');
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const needsLists = role === 'DOCTOR' && step === 'details';
  const specialties = useQuery(needsLists ? 'specialties' : null, () => api<Specialty[]>('/specialties'));
  const clinics = useQuery(needsLists ? 'clinics' : null, () => api<Clinic[]>('/clinics'));

  const set = (field: keyof typeof EMPTY) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => without(current, field)); // clear a field's message as soon as it is edited
  };

  if (!hydrated || authState === 'loading') return <Spinner />;
  // An older CareSlot account uses this verified email: link it by proving it is theirs (never automatically).
  if (authState === 'needs-link' && clerk.account?.state === 'LINK_REQUIRED') return <LinkAccountPanel email={clerk.account.email} />;
  // Unverified or ambiguous email: explains what to do instead of guessing.
  if (authState === 'blocked') return <ContinueRedirect />;
  if (!draft && !clerkMode) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState title="Your sign-up isn't active">
          <p>Create an account first, or sign in if you already started one.</p>
          <div className="flex gap-2">
            <Link href="/signup" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
              Create account
            </Link>
            <Link href="/login" className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-10' })}>
              Sign in
            </Link>
          </div>
        </EmptyState>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!role) return;
    setFormError(null);
    const found = role === 'PATIENT' ? validatePatient(form, today) : validateDoctor(form);
    setErrors(found);
    if (Object.keys(found).length) return;

    const body =
      role === 'PATIENT'
        ? {
            role,
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            ...(form.phone.trim() && { phone: form.phone.trim() }),
            ...(form.dateOfBirth && { dateOfBirth: form.dateOfBirth }),
            ...(form.gender && { gender: form.gender }),
          }
        : {
            role,
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            specialtyId: form.specialtyId,
            clinicId: form.clinicId,
            consultationFee: Number(form.fee),
            ...(form.bio.trim() && { bio: form.bio.trim() }),
          };

    setSubmitting(true);
    try {
      if (clerkMode) {
        // The Clerk sign-in is the credential: no token is stored. The response says which account was created.
        const created = await api<{ user: PublicUser }>('/auth/clerk/complete-profile', { method: 'POST', token: clerk.getToken, body });
        setClerkState({ account: { state: 'LINKED', user: created.user } });
      } else {
        const session = await api<Session>('/auth/complete-profile', { method: 'POST', token: draft?.signupToken, body });
        saveSession(session);
        saveSignupDraft(null);
      }
      router.push(role === 'DOCTOR' ? '/doctor' : '/dashboard');
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        const fromServer = fieldErrorsFromApi(error.details);
        if (fromServer.consultationFee) fromServer.fee = fromServer.consultationFee; // the form calls this field "fee"
        setErrors(fromServer);
        if (!Object.keys(fromServer).length) setFormError(error.message);
      } else {
        setFormError(errorMessage(error));
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
      <Stepper steps={SIGNUP_STEPS} current={step === 'role' ? 2 : 3} />

      {step === 'role' ? (
        <Card className="[--card-spacing:--spacing(6)]">
          <CardHeader>
            <p className="text-xs font-semibold tracking-widest text-primary uppercase">Email verified</p>
            <CardTitle as="h1" className="text-2xl font-bold">
              How will you use CareSlot?
            </CardTitle>
            <CardDescription>Choose the option that describes you. You cannot change this later.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <RadioGroup
              value={role ?? ''}
              onValueChange={(value) => setRole(value as Role)}
              aria-label="How will you use CareSlot?"
              className="grid gap-3 sm:grid-cols-2"
            >
              {ROLE_OPTIONS.map((option) => (
                <Label
                  key={option.role}
                  className={cn(
                    'cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 font-normal transition-all hover:border-primary/50 hover:shadow-sm',
                    'has-data-checked:border-primary has-data-checked:bg-accent has-data-checked:shadow-sm',
                  )}
                >
                  <RadioGroupItem value={option.role} className="mt-1" />
                  <span className="space-y-1">
                    <span className="flex items-center gap-2 font-semibold text-foreground">
                      <option.icon className="size-4 text-primary" aria-hidden />
                      {option.title}
                    </span>
                    <span className="block text-sm text-muted-foreground">{option.text}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
            <Button size="lg" className="h-10 w-full sm:w-auto sm:px-8" disabled={!role} onClick={() => setStep('details')}>
              Continue
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="[--card-spacing:--spacing(6)]">
          <form onSubmit={submit} noValidate className="contents">
            <CardHeader>
              <Button
                type="button"
                variant="link"
                className="h-auto w-fit gap-1.5 p-0 text-muted-foreground"
                onClick={() => {
                  setStep('role');
                  setErrors({});
                  setFormError(null);
                }}
              >
                <ArrowLeftIcon aria-hidden />
                Back to role
              </Button>
              <p className="text-xs font-semibold tracking-widest text-primary uppercase">
                {role === 'DOCTOR' ? 'Doctor' : 'Patient'} profile
              </p>
              <CardTitle as="h1" className="text-2xl font-bold">
                Your profile details
              </CardTitle>
              <CardDescription>
                Signing up as <span className="font-medium text-foreground">{signupEmail}</span>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {formError && (
                <Alert>
                  {formError}{' '}
                  {(formError.includes('expired') || formError.includes('already exists')) && (
                    <Link href="/login" className="font-medium underline">
                      Sign in
                    </Link>
                  )}
                </Alert>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="first-name" label="First name" error={errors.firstName}>
                  <Input {...fieldProps('first-name', errors.firstName)} autoComplete="given-name" value={form.firstName} onChange={(e) => set('firstName')(e.target.value)} className="h-10" />
                </Field>
                <Field id="last-name" label="Last name" error={errors.lastName}>
                  <Input {...fieldProps('last-name', errors.lastName)} autoComplete="family-name" value={form.lastName} onChange={(e) => set('lastName')(e.target.value)} className="h-10" />
                </Field>
              </div>

              {role === 'PATIENT' ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field id="phone" label="Phone" optional error={errors.phone}>
                      <Input {...fieldProps('phone', errors.phone)} type="tel" autoComplete="tel" placeholder="+91 98765 43210" value={form.phone} onChange={(e) => set('phone')(e.target.value)} className="h-10" />
                    </Field>
                    <Field id="dob" label="Date of birth" optional error={errors.dateOfBirth}>
                      <Input {...fieldProps('dob', errors.dateOfBirth)} type="date" autoComplete="bday" max={today ?? undefined} value={form.dateOfBirth} onChange={(e) => set('dateOfBirth')(e.target.value)} className="h-10" />
                    </Field>
                  </div>
                  <Field id="gender" label="Gender" optional error={errors.gender}>
                    <select {...fieldProps('gender', errors.gender)} value={form.gender} onChange={(e) => set('gender')(e.target.value)} className={cn(controlClass, 'h-10')}>
                      <option value="">Select…</option>
                      <option>Male</option>
                      <option>Female</option>
                      <option>Other</option>
                      <option>Prefer not to say</option>
                    </select>
                  </Field>
                </>
              ) : (
                <>
                  {(specialties.error || clinics.error) && (
                    <Alert
                      action={
                        <Button size="sm" variant="outline" onClick={() => { specialties.reload(); clinics.reload(); }}>
                          Try again
                        </Button>
                      }
                    >
                      Could not load the specialty and clinic lists. {specialties.error ?? clinics.error}
                    </Alert>
                  )}
                  <Field id="specialty" label="Specialty" error={errors.specialtyId}>
                    <select {...fieldProps('specialty', errors.specialtyId)} value={form.specialtyId} onChange={(e) => set('specialtyId')(e.target.value)} disabled={specialties.loading} className={cn(controlClass, 'h-10')}>
                      <option value="">{specialties.loading ? 'Loading…' : 'Select your specialty'}</option>
                      {specialties.data?.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="clinic" label="Clinic" error={errors.clinicId}>
                    <select {...fieldProps('clinic', errors.clinicId)} value={form.clinicId} onChange={(e) => set('clinicId')(e.target.value)} disabled={clinics.loading} className={cn(controlClass, 'h-10')}>
                      <option value="">{clinics.loading ? 'Loading…' : 'Select your clinic'}</option>
                      {clinics.data?.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {item.address}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="fee" label="Consultation fee (₹)" error={errors.fee} hint="Whole rupees. Patients pay at the clinic.">
                    <Input {...fieldProps('fee', errors.fee, 'Whole rupees. Patients pay at the clinic.')} inputMode="numeric" value={form.fee} onChange={(e) => set('fee')(e.target.value)} className="h-10 sm:w-48" />
                  </Field>
                  <Field id="bio" label="Bio" optional error={errors.bio} hint={`${form.bio.length}/1000. Qualifications and experience help patients choose.`}>
                    <textarea
                      {...fieldProps('bio', errors.bio, 'bio-hint')}
                      rows={4}
                      maxLength={1000}
                      value={form.bio}
                      onChange={(e) => set('bio')(e.target.value)}
                      placeholder="For example: MBBS, MD (Internal Medicine). 12 years of experience."
                      className={cn(controlClass, 'min-h-24 py-2')}
                    />
                  </Field>
                  <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                    After this step you can set your weekly hours, session capacity and slot length in your dashboard.
                  </p>
                </>
              )}

              <Button type="submit" size="lg" disabled={submitting} className="h-10 w-full sm:w-auto sm:px-8">
                {submitting ? 'Creating profile…' : 'Create profile'}
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}
