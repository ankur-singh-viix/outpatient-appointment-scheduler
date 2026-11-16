/**
 * Keeps a screen up to date by asking the server again and again (polling: no WebSockets). It is plain TypeScript with the browser's
 * clock, timers and tab visibility injected, so its timing is tested in Node.
 *
 *  - One request at a time. The next is scheduled only after the last one has finished, so a slow server is never piled onto.
 *  - A hidden tab asks for nothing. When the tab (or window) becomes active again it refreshes at once, unless it only just did.
 *  - Failures back the pace off (the wait doubles each time, up to a cap) and keep the last good data on screen; the first success
 *    brings back the normal pace.
 *  - `intervalMs` can depend on the latest data, so a screen with nothing to show can ask less often.
 *  - After stop(), nothing it was waiting for can reach the screen.
 */
export interface PollerEnv {
  /** False while the tab is hidden. */
  visible(): boolean;
  /** Calls back when the tab becomes visible or the window regains focus. Returns how to stop listening. */
  onVisible(callback: () => void): () => void;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const browserEnv: PollerEnv = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onVisible: (callback) => {
    const onChange = () => {
      if (document.visibilityState === 'visible') callback();
    };
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', callback);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', callback);
    };
  },
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PollerOptions<T> {
  fetch: () => Promise<T>;
  onData: (data: T, at: number) => void;
  onError: (error: unknown, at: number) => void;
  /** How long to wait between requests, or a function of the latest data (undefined until the first answer). */
  intervalMs: number | ((latest: T | undefined) => number);
  /** Coming back to the tab does not refresh if the last request was this recent. Default 2 seconds. */
  minGapMs?: number;
  /** The longest wait after repeated failures. Default one minute. */
  maxBackoffMs?: number;
  env?: PollerEnv;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Asks now. If a request is already running, that one is the answer. */
  refresh(): Promise<void>;
  /** Asks now and is guaranteed to start a request after this call, for use right after the person changed something. */
  refreshFresh(): Promise<void>;
}

export function createPoller<T>(options: PollerOptions<T>): Poller {
  const env = options.env ?? browserEnv;
  const minGap = options.minGapMs ?? 2000;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  let timer: unknown = null;
  let stopped = true;
  let inFlight: Promise<void> | null = null;
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  let failures = 0;
  let latest: T | undefined;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;

  const clear = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };
  const delay = () => {
    const base = typeof options.intervalMs === 'function' ? options.intervalMs(latest) : options.intervalMs;
    return Math.min(base * 2 ** failures, Math.max(maxBackoff, base));
  };
  const schedule = () => {
    if (stopped) return;
    clear();
    timer = env.setTimer(tick, delay());
  };
  const tick = () => {
    timer = null;
    if (stopped || !env.visible()) return; // a hidden tab asks for nothing; coming back resumes
    void refresh();
  };
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const mine = generation;
    lastFetchAt = env.now();
    clear();
    const request = options
      .fetch()
      .then(
        (data) => {
          if (mine !== generation) return;
          latest = data;
          failures = 0;
          options.onData(data, env.now());
        },
        (error: unknown) => {
          if (mine !== generation) return;
          failures += 1;
          options.onError(error, env.now());
        },
      )
      .finally(() => {
        if (mine !== generation) return;
        inFlight = null;
        schedule();
      });
    inFlight = request;
    return request;
  };
  const resume = () => {
    if (stopped || !env.visible()) return;
    if (env.now() - lastFetchAt >= minGap) void refresh();
    else if (timer === null && !inFlight) schedule();
  };

  return {
    start() {
      generation += 1;
      stopped = false;
      inFlight = null;
      failures = 0;
      unsubscribe?.();
      unsubscribe = env.onVisible(resume);
      if (env.visible()) void refresh();
    },
    stop() {
      generation += 1;
      stopped = true;
      inFlight = null;
      clear();
      unsubscribe?.();
      unsubscribe = null;
    },
    refresh,
    refreshFresh() {
      const pending = inFlight;
      return pending ? pending.then(() => refresh()) : refresh();
    },
  };
}

/** True when the last good answer is old enough that what is on screen may be out of date: three polls, and never less than 30 seconds. */
export function isStale(lastSuccessAt: number | null, now: number, intervalMs: number): boolean {
  return lastSuccessAt !== null && now - lastSuccessAt > Math.max(intervalMs * 3, 30_000);
}
