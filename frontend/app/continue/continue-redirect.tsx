'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Alert, Spinner } from '@/components/common';
import { Button, buttonVariants } from '@/components/ui/button';
import { useClerkState } from '@/lib/clerk-state';
import { signOutEverywhere, useAuthState, useSession } from '@/lib/session';

/** Sends a freshly signed-in person to the right place: their home, the setup steps, or back to sign in. */
export function ContinueRedirect() {
  const router = useRouter();
  const state = useAuthState();
  const session = useSession();
  const clerk = useClerkState();

  useEffect(() => {
    if (state === 'signed-in' && session) router.replace(session.user.role === 'DOCTOR' ? '/doctor' : '/dashboard');
    else if (state === 'needs-profile' || state === 'needs-link') router.replace('/onboarding');
    else if (state === 'signed-out') router.replace('/login');
  }, [state, session, router]);

  if (state !== 'blocked') return <Spinner label="Signing you in…" />;

  const reason =
    clerk.accountError ??
    (clerk.account?.state === 'EMAIL_UNVERIFIED'
      ? 'Your email address has not been verified yet. Verify it with Clerk, then sign in again.'
      : 'We could not set up your account automatically because your email matches more than one existing account or a sign-in that is already linked. Please contact support.');
  return (
    <div className="mx-auto max-w-md space-y-4">
      <Alert>{reason}</Alert>
      <div className="flex gap-2">
        <Button variant="outline" size="lg" className="h-10" onClick={() => void signOutEverywhere()}>
          Sign out
        </Button>
        <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'lg', className: 'h-10' })}>
          Back to the doctor list
        </Link>
      </div>
    </div>
  );
}
