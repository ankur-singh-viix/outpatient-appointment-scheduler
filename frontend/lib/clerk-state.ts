'use client';

import { useSyncExternalStore } from 'react';
import type { ClerkAccountStatus, TokenGetter } from './types';

// What Clerk knows in the browser (loaded? signed in? a way to fetch a token) plus what OUR backend says about that
// sign-in. Clerk's hooks only work inside its provider, so a small bridge component copies them into this store, and the
// rest of the app reads it through useSession() / useAuthState() without touching Clerk directly.

export interface ClerkState {
  /** Clerk has finished loading in the browser. */
  loaded: boolean;
  signedIn: boolean;
  getToken: TokenGetter;
  signOut: () => Promise<void>;
  /** The backend's view of the signed-in Clerk user. Undefined while loading, or when signed out. */
  account: ClerkAccountStatus | undefined;
  /** Set when asking the backend about the account failed. */
  accountError: string | null;
}

const INITIAL: ClerkState = {
  loaded: false,
  signedIn: false,
  getToken: async () => null,
  signOut: async () => {},
  account: undefined,
  accountError: null,
};

let state: ClerkState = INITIAL;
const listeners = new Set<() => void>();

export function setClerkState(patch: Partial<ClerkState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

/** The current value, for code that is not a React component (for example sign-out). */
export function getClerkState(): ClerkState {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useClerkState(): ClerkState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}
