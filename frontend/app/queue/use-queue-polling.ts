'use client';

import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { useNow } from '@/lib/hooks';
import { createPoller, isStale, type Poller } from '@/lib/queue-poller';

interface State<T> {
  key: string;
  data?: T;
  error: string | null;
  updatedAt: number | null;
}

/**
 * A queue screen's data, kept up to date by polling (see lib/queue-poller: one request at a time, nothing while the tab is hidden, an
 * immediate refresh when it comes back, a slower pace after failures). A failed refresh never clears what is on screen: the last
 * good answer stays, with `error` set, and `stale` says when it is old enough that it may be out of date.
 *
 * `refresh()` is for use right after the person did something: it always asks again after the call, so the screen shows the result.
 */
export function useQueuePolling<T>(key: string | null, fetcher: () => Promise<T>, intervalMs: number | ((latest: T | undefined) => number)) {
  const [state, setState] = useState<State<T> | null>(null);
  const pollerRef = useRef<Poller | null>(null);
  const fetcherRef = useRef(fetcher);
  const intervalRef = useRef(intervalMs);
  const now = useNow(5_000);

  useEffect(() => {
    fetcherRef.current = fetcher;
    intervalRef.current = intervalMs;
  });

  useEffect(() => {
    if (key === null) return;
    const poller = createPoller<T>({
      fetch: () => fetcherRef.current(),
      onData: (data, at) => setState({ key, data, error: null, updatedAt: at }),
      onError: (error) =>
        setState((current) => ({
          key,
          data: current?.key === key ? current.data : undefined,
          error: errorMessage(error),
          updatedAt: current?.key === key ? current.updatedAt : null,
        })),
      intervalMs: (latest) => (typeof intervalRef.current === 'function' ? intervalRef.current(latest) : intervalRef.current),
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
  }, [key]);

  const current = state?.key === key ? state : null;
  const interval = typeof intervalMs === 'function' ? intervalMs(current?.data) : intervalMs;
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: key !== null && current === null,
    stale: isStale(current?.updatedAt ?? null, now, interval),
    updatedAt: current?.updatedAt ?? null,
    refresh: (): Promise<void> => pollerRef.current?.refreshFresh() ?? Promise.resolve(),
  };
}
