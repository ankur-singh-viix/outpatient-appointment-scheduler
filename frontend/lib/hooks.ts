'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from './api';
import { clinicToday } from './format';

interface QueryState<T> {
  key: string;
  data?: T;
  error?: string;
}

/**
 * Minimal data loader. Re-fetches whenever `key` changes (pass null to skip).
 * `data` is the result for the current key; `previous` is the last result for any key,
 * useful for keeping old results on screen while new ones load.
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<QueryState<T> | null>(null);
  const fetcherRef = useRef(fetcher);
  const fullKey = key === null ? null : `${key}#${version}`;

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (fullKey === null) return;
    let cancelled = false;
    fetcherRef.current().then(
      (data) => !cancelled && setState({ key: fullKey, data }),
      (error: unknown) => !cancelled && setState({ key: fullKey, error: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [fullKey]);

  const current = state?.key === fullKey ? state : null;
  return {
    data: current?.data,
    previous: state?.data,
    error: current?.error ?? null,
    loading: fullKey !== null && current === null,
    reload: () => setVersion((v) => v + 1),
  };
}

/** Returns `value` after it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const noopSubscribe = () => () => {};

/** Today's date (YYYY-MM-DD) in the clinic time zone; null until running in the browser. */
export function useClinicToday(): string | null {
  return useSyncExternalStore(noopSubscribe, clinicToday, () => null);
}

/** Calls `callback` every `intervalMs` while the component is on screen, always using the latest version of it. */
export function useAutoRefresh(callback: () => void, intervalMs = 30_000): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    const timer = setInterval(() => latest.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

/** The current time in ms, refreshed on an interval so "booked 5 min ago" labels stay accurate. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
