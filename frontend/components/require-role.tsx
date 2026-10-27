'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { useHydrated, useSession } from '@/lib/session';
import type { Role, Session } from '@/lib/types';
import { EmptyState, Spinner } from './common';

/**
 * Shows `children` only to signed-in users with the given role. This is for UX only:
 * the API enforces the same rule on every request.
 */
export function RequireRole({
  role,
  nextPath,
  children,
}: {
  role: Role;
  nextPath: string;
  children: (session: Session) => ReactNode;
}) {
  const hydrated = useHydrated();
  const session = useSession();

  if (!hydrated) return <Spinner />;
  if (!session) {
    return (
      <EmptyState title="Please sign in">
        <p>You need to sign in as a {role.toLowerCase()} to view this page.</p>
        <Link href={`/login?next=${encodeURIComponent(nextPath)}`} className={buttonVariants({ size: 'lg' })}>
          Sign in
        </Link>
      </EmptyState>
    );
  }
  if (session.user.role !== role) {
    return (
      <EmptyState title="Not available for this account">
        This page is for {role.toLowerCase()}s. You are signed in as {session.user.name} ({session.user.role.toLowerCase()}).
      </EmptyState>
    );
  }
  return <>{children(session)}</>;
}
