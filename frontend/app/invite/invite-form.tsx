'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Spinner } from '@/components/common';
import { Field, fieldProps } from '@/components/form-field';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { homeFor } from '@/lib/home';
import { useQuery } from '@/lib/hooks';
import { saveSession } from '@/lib/session';
import type { Session } from '@/lib/types';

const MIN_PASSWORD = 8;

/**
 * Where an invited receptionist chooses their password. The link carries a one-time token; the page first asks the server whose
 * account it is (and whether the link is still good), then sets the password and signs them in to the front desk.
 */
export function InviteForm() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const invitation = useQuery(token ? `invitation:${token.slice(-16)}` : null, () =>
    api<{ name: string; email: string }>('/auth/invitations/inspect', { method: 'POST', body: { token } }),
  );
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    const found: typeof fieldError = {};
    if (password.length < MIN_PASSWORD) found.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (confirm !== password) found.confirm = 'The two passwords do not match.';
    setFieldError(found);
    if (found.password || found.confirm) return;
    setError(null);
    setSubmitting(true);
    try {
      const session = await api<Session>('/auth/invitations/accept', { method: 'POST', body: { token, password } });
      saveSession(session);
      router.push(homeFor(session.user.role));
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  const problem = !token ? 'This invitation link is incomplete. Open the link from your email again.' : invitation.error;

  return (
    <div className="mx-auto max-w-md">
      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle as="h1" className="text-2xl font-bold">
            Welcome to CareSlot
          </CardTitle>
          <CardDescription>Choose a password to finish setting up your front desk account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {token && invitation.loading && !invitation.data && <Spinner label="Checking your invitation…" />}
          {problem && (
            <>
              <Alert>{problem}</Alert>
              <Link href="/login" className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-10 w-full' })}>
                Go to sign in
              </Link>
            </>
          )}
          {invitation.data && (
            <form onSubmit={submit} noValidate className="space-y-4">
              <p className="rounded-lg bg-muted p-3 text-sm">
                <span className="font-medium text-foreground">{invitation.data.name}</span>
                <span className="block text-muted-foreground">{invitation.data.email}</span>
              </p>
              {error && <Alert>{error}</Alert>}
              <Field id="invite-password" label="Password" hint={`At least ${MIN_PASSWORD} characters.`} error={fieldError.password}>
                <Input
                  {...fieldProps('invite-password', fieldError.password, 'hint')}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-10"
                />
              </Field>
              <Field id="invite-confirm" label="Repeat the password" error={fieldError.confirm}>
                <Input
                  {...fieldProps('invite-confirm', fieldError.confirm)}
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-10"
                />
              </Field>
              <Button type="submit" size="lg" disabled={submitting} className="h-10 w-full">
                {submitting ? 'Saving…' : 'Set password and sign in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
