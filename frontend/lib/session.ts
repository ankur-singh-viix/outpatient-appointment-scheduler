'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { CLERK_ENABLED } from './clerk-config';
import { getClerkState, setClerkState, useClerkState } from './clerk-state';
import type { Session } from './types';

// Two ways to be signed in, one `useSession()` for the app:
//  * the legacy login: a stored token in localStorage (demo accounts, existing logins, and the fallback during migration);
//  * Clerk: the browser holds Clerk's session, and a fresh token is fetched for each request.
// Components never need to know which one is active.
const STORAGE_KEY = 'careslot.session';
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedSession: Session | null = null;

function readSession(): Session | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked site data): treat as signed out.
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedSession = raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      cachedSession = null;
    }
  }
  return cachedSession;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Keeps tabs in sync when the user signs in or out in another tab.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Saves (or, with null, clears) the legacy login session. */
export function saveSession(session: Session | null) {
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: the session just won't survive a reload.
  }
  listeners.forEach((listener) => listener());
}

function useLegacySession(): Session | null {
  return useSyncExternalStore(subscribe, readSession, () => null);
}

/** The signed-in user (legacy login, or a Clerk sign-in linked to a CareSlot account), or null. Null while rendering on the server. */
export function useSession(): Session | null {
  const legacy = useLegacySession();
  const clerk = useClerkState();
  const clerkUser = clerk.account?.state === 'LINKED' ? clerk.account.user : null;
  const clerkSession = useMemo<Session | null>(
    () => (clerkUser ? { accessToken: clerk.getToken, user: clerkUser } : null),
    [clerkUser, clerk.getToken],
  );
  return legacy ?? clerkSession;
}

export type AuthState =
  | 'loading'
  | 'signed-out'
  | 'signed-in'
  /** Signed in with Clerk, but no CareSlot account yet: choose a role and fill in a profile. */
  | 'needs-profile'
  /** Signed in with Clerk, and an old CareSlot account uses the same verified email: prove it is theirs to link it. */
  | 'needs-link'
  /** Signed in with Clerk, but something stops the account being set up automatically (unverified or ambiguous email). */
  | 'blocked';

/** Where the visitor stands: used to decide between showing a page, a sign-in prompt, or the setup steps. */
export function useAuthState(): AuthState {
  const hydrated = useHydrated();
  const legacy = useLegacySession();
  const clerk = useClerkState();

  if (!hydrated) return 'loading';
  if (legacy) return 'signed-in';
  if (!CLERK_ENABLED) return 'signed-out';
  if (!clerk.loaded) return 'loading';
  if (!clerk.signedIn) return 'signed-out';
  if (clerk.accountError) return 'blocked';
  if (!clerk.account) return 'loading';
  switch (clerk.account.state) {
    case 'LINKED':
      return 'signed-in';
    case 'ONBOARDING_REQUIRED':
      return 'needs-profile';
    case 'LINK_REQUIRED':
      return 'needs-link';
    default:
      return 'blocked';
  }
}

/** Signs out of whichever kind of session is active (or both). */
export async function signOutEverywhere(): Promise<void> {
  saveSession(null);
  const clerk = getClerkState();
  if (clerk.signedIn) await clerk.signOut();
  setClerkState({ account: undefined, accountError: null });
}

const noopSubscribe = () => () => {};

/** False during server rendering and hydration, true once running in the browser. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
