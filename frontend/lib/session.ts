'use client';

import { useSyncExternalStore } from 'react';
import type { Session } from './types';

// The signed-in session lives in localStorage, exposed to React as an external store
// so every component (header, booking panel, dashboard) sees the same value.
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

export function saveSession(session: Session | null) {
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: the session just won't survive a reload.
  }
  listeners.forEach((listener) => listener());
}

/** Current session, or null when signed out (always null during server rendering). */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, readSession, () => null);
}

const noopSubscribe = () => () => {};

/** False during server rendering and hydration, true once running in the browser. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
