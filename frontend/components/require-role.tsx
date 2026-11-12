'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { useAuthState, useSession } from '@/lib/session';
import type { Role, Session } from '@/lib/types';
import { EmptyState, Spinner } from './common';

/**
 * Shows `children` only to signed-in users with the given role (or any one of several roles). This is for UX only:
 * the API enforces the same rule on every request.
 */
export function RequireRole({
  role,
  nextPath,
  children,
}: {
  role: Role | Role[];
  nextPath: string;
  children: (session: Session) => ReactNode;
}) {
  const allowed = Array.isArray(role) ? role : [role];
  const roleWords = allowed.map((each) => each.toLowerCase()).join(' or ');
  const state = useAuthState();
  const session = useSession();

  if (state === 'loading') return <Spinner />;
  // Signed in with Clerk but no CareSlot account is linked yet: there is nothing to show until that is sorted out.
  if (state === 'needs-profile' || state === 'needs-link' || state === 'blocked') {
    return (
      <EmptyState title="Finish setting up your account">
        <p>You are signed in, but your CareSlot account is not set up yet.</p>
        <Link href="/onboarding" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
          Continue setup
        </Link>
      </EmptyState>
    );
  }
  if (!session) {
    return (
      <EmptyState title="Please sign in">
        <p>You need to sign in as a {roleWords} to view this page.</p>
        <Link href={`/login?next=${encodeURIComponent(nextPath)}`} className={buttonVariants({ size: 'lg', className: 'h-10' })}>
          Sign in
        </Link>
      </EmptyState>
    );
  }
  if (!allowed.includes(session.user.role)) {
    return (
      <EmptyState title="Not available for this account">
        This page is for {roleWords}s. You are signed in as {session.user.name} ({session.user.role.toLowerCase()}).
      </EmptyState>
    );
  }
  return <>{children(session)}</>;
}
