'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect, useRef } from 'react';
import { api, errorMessage } from '@/lib/api';
import { setClerkState } from '@/lib/clerk-state';
import type { ClerkAccountStatus } from '@/lib/types';

/**
 * Lives inside <ClerkProvider> and copies what Clerk knows into our small store, so the rest of the app never has to use
 * Clerk's hooks. When someone is signed in with Clerk it also asks OUR backend where they stand: linked to a CareSlot
 * account, needing a profile, or needing to link an older account. Renders nothing.
 */
export function ClerkAuthBridge() {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();

  // Always call the latest functions without making them dependencies (their identity is not guaranteed to be stable).
  const latest = useRef({ getToken, signOut });
  useEffect(() => {
    latest.current = { getToken, signOut };
  });

  useEffect(() => {
    setClerkState({
      loaded: isLoaded,
      signedIn: Boolean(isSignedIn),
      getToken: () => latest.current.getToken(),
      signOut: () => latest.current.signOut(),
    });
  }, [isLoaded, isSignedIn]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setClerkState({ account: undefined, accountError: null });
      return;
    }
    let cancelled = false;
    api<ClerkAccountStatus>('/auth/clerk/status', { token: () => latest.current.getToken() }).then(
      (account) => {
        if (!cancelled) setClerkState({ account, accountError: null });
      },
      (error: unknown) => {
        if (!cancelled) setClerkState({ account: undefined, accountError: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, userId]);

  return null;
}
