'use client';

import { LinkIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Field, fieldProps } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { setClerkState, useClerkState } from '@/lib/clerk-state';
import { signOutEverywhere } from '@/lib/session';
import type { PublicUser } from '@/lib/types';

/**
 * Shown when a CareSlot account already uses the email the person just verified with Clerk. Sharing an email is never
 * enough to link them: they must enter that account's current CareSlot password. Nothing is merged, copied or deleted;
 * their appointments and role stay exactly as they were.
 */
export function LinkAccountPanel({ email }: { email: string }) {
  const router = useRouter();
  const clerk = useClerkState();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) {
      setError('Enter the password of your existing CareSlot account.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const linked = await api<{ user: PublicUser }>('/auth/clerk/link', { method: 'POST', token: clerk.getToken, body: { password } });
      setClerkState({ account: { state: 'LINKED', user: linked.user } });
      router.push(linked.user.role === 'DOCTOR' ? '/doctor' : '/dashboard');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401 ? 'That password is not correct for the existing account.' : errorMessage(err),
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
      <Card className="[--card-spacing:--spacing(6)]">
        <form onSubmit={submit} noValidate className="contents">
          <CardHeader>
            <span className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden>
              <LinkIcon className="size-5" />
            </span>
            <CardTitle as="h1" className="text-2xl font-bold">
              Link your existing account
            </CardTitle>
            <CardDescription>
              A CareSlot account already uses <span className="font-medium text-foreground">{email}</span>. To connect it to this
              sign-in, confirm it is yours with that account&apos;s CareSlot password. Your appointments and details stay as they are.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert>{error}</Alert>}
            <Field id="link-password" label="CareSlot account password" error={undefined} hint="The password you used before signing in with Clerk.">
              <Input
                {...fieldProps('link-password', undefined, 'hint')}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                className="h-10"
              />
            </Field>
            <Button type="submit" size="lg" disabled={submitting} className="h-10 w-full">
              {submitting ? 'Linking…' : 'Link my account'}
            </Button>
            <Button type="button" variant="ghost" size="lg" className="h-9 w-full text-muted-foreground" onClick={() => void signOutEverywhere()}>
              Not my account? Sign out
            </Button>
          </CardContent>
        </form>
      </Card>
    </div>
  );
}
