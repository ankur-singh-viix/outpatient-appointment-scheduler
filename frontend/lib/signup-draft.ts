'use client';

import { useSyncExternalStore } from 'react';

// A sign-up in progress: the email being verified and, once verified, the short-lived token that allows finishing
// the profile. It lives in sessionStorage (cleared when the tab closes), never localStorage, and holds no password.
const STORAGE_KEY = 'careslot.signup';
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedDraft: SignupDraft | null = null;

export interface SignupDraft {
  email: string;
  signupToken: string;
}

function read(): SignupDraft | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable: treat as no sign-up in progress.
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedDraft = raw ? (JSON.parse(raw) as SignupDraft) : null;
    } catch {
      cachedDraft = null;
    }
  }
  return cachedDraft;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function saveSignupDraft(draft: SignupDraft | null) {
  try {
    if (draft) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: the visitor would have to sign in again to continue.
  }
  listeners.forEach((listener) => listener());
}

/** The sign-up in progress, or null (always null during server rendering). */
export function useSignupDraft(): SignupDraft | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
