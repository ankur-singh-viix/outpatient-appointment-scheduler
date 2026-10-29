'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Link from 'next/link';
import { ApiError, api, errorMessage } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { saveSignupDraft } from '@/lib/signup-draft';
import type { LoginResult } from '@/lib/types';

// Seeded by `npm run db:seed` in the backend.
const DEMO_PASSWORD = 'Demo@1234';
const DEMO_ACCOUNTS = [
  { label: 'Patient · Rahul Sharma', email: 'patient@example.com' },
  { label: 'Doctor · Dr. Rohan Das (ENT)', email: 'rohan.das@example.com' },
  { label: 'Doctor · Dr. Ananya Rao (GP)', email: 'ananya.rao@example.com' },
];

/** Only allow same-site relative redirects after login. */
function safeNext(next: string | null): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (event?: FormEvent, credentials = { email, password }) => {
    event?.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<LoginResult>('/auth/login', { method: 'POST', body: credentials });
      if ('onboardingRequired' in result) {
        // The email is verified but no role or profile was chosen yet: carry on where they stopped.
        saveSignupDraft({ email: result.email, signupToken: result.signupToken });
        router.push('/onboarding');
        return;
      }
      saveSession(result);
      router.push(next ?? (result.user.role === 'DOCTOR' ? '/doctor' : '/dashboard'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        router.push(`/signup/legacy?step=verify&email=${encodeURIComponent(credentials.email.trim())}`);
        return;
      }
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
      <Card className="[--card-spacing:--spacing(6)]">
        <form onSubmit={signIn} className="contents">
          <CardHeader>
            <CardTitle as="h1" className="text-2xl font-bold">
              Sign in
            </CardTitle>
            <CardDescription>Patients sign in to book. Doctors sign in to manage their schedule.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert>{error}</Alert>}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9"
              />
            </div>
            <Button type="submit" size="lg" disabled={submitting} className="w-full">
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              New to CareSlot?{' '}
              <Link href="/signup" className="font-medium text-primary hover:underline">
                Create an account
              </Link>
            </p>
          </CardContent>
        </form>
      </Card>

      <Card className="h-fit [--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle as="h2" className="text-lg font-semibold">
            Demo accounts
          </CardTitle>
          <CardDescription>
            All demo accounts use the password{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{DEMO_PASSWORD}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email}>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={submitting}
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(DEMO_PASSWORD);
                    void signIn(undefined, { email: account.email, password: DEMO_PASSWORD });
                  }}
                  className="h-auto w-full flex-wrap justify-between gap-x-3 py-2"
                >
                  <span>{account.label}</span>
                  <span className="font-normal text-muted-foreground">{account.email}</span>
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
