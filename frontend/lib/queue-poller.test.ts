import { describe, expect, it } from 'vitest';
import { createPoller, isStale, type PollerEnv } from './queue-poller';

const flush = async () => {
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
};

/** A clock, timers and tab visibility the test controls. */
function fakeEnv(startVisible = true) {
  let now = 1_000_000;
  let visible = startVisible;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Set<() => void>();
  const env: PollerEnv = {
    visible: () => visible,
    onVisible: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    now: () => now,
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  };
  return {
    env,
    /** Moves the clock forward, running the timers that fall due, in order. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
    async setVisible(next: boolean) {
      visible = next;
      if (next) for (const callback of [...listeners]) callback();
      await flush();
    },
    pendingTimers: () => timers.size,
    listening: () => listeners.size,
  };
}

/** A fetch the test answers by hand, so it can be slow, or fail. */
function fakeFetch() {
  const calls: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  return {
    calls,
    fetch: () => new Promise<string>((resolve, reject) => void calls.push({ resolve, reject })),
    async answer(index: number, value: string) {
      calls[index].resolve(value);
      await flush();
    },
    async fail(index: number, message = 'down') {
      calls[index].reject(new Error(message));
      await flush();
    },
  };
}

function setup(options: { intervalMs?: number | ((latest: string | undefined) => number); startVisible?: boolean; minGapMs?: number } = {}) {
  const clock = fakeEnv(options.startVisible ?? true);
  const server = fakeFetch();
  const data: string[] = [];
  const errors: string[] = [];
  const poller = createPoller<string>({
    fetch: server.fetch,
    onData: (value) => void data.push(value),
    onError: (error) => void errors.push((error as Error).message),
    intervalMs: options.intervalMs ?? 10_000,
    minGapMs: options.minGapMs,
    env: clock.env,
  });
  return { clock, server, data, errors, poller };
}

describe('createPoller: polling', () => {
  it('asks at once when started, and hands over what the server says', async () => {
    const { server, data, poller } = setup();
    poller.start();
    expect(server.calls).toHaveLength(1);
    await server.answer(0, 'first');
    expect(data).toEqual(['first']);
    poller.stop();
  });

  it('asks again after each interval, counted from the end of the last answer', async () => {
    const { clock, server, poller } = setup();
    poller.start();
    await server.answer(0, 'a');
    await clock.advance(9_999);
    expect(server.calls).toHaveLength(1);
    await clock.advance(1);
    expect(server.calls).toHaveLength(2);
    await server.answer(1, 'b');
    await clock.advance(10_000);
    expect(server.calls).toHaveLength(3);
    poller.stop();
  });

  it('never has two requests running: a slow answer is waited for, not piled onto', async () => {
    const { clock, server, poller } = setup();
    poller.start();
    await clock.advance(120_000); // the first request has not been answered for two minutes
    expect(server.calls).toHaveLength(1);
    await server.answer(0, 'late');
    await clock.advance(10_000);
    expect(server.calls).toHaveLength(2);
    poller.stop();
  });

  it('can ask less often when there is nothing to show', async () => {
    const { clock, server, poller } = setup({ intervalMs: (latest) => (latest === 'empty' ? 60_000 : 10_000) });
    poller.start();
    await server.answer(0, 'empty');
    await clock.advance(59_999);
    expect(server.calls).toHaveLength(1);
    await clock.advance(1);
    expect(server.calls).toHaveLength(2);
    await server.answer(1, 'busy');
    await clock.advance(10_000);
    expect(server.calls).toHaveLength(3);
    poller.stop();
  });
});

describe('createPoller: the tab', () => {
  it('asks for nothing while the tab is hidden, and refreshes the moment it is shown again', async () => {
    const { clock, server, poller } = setup();
    poller.start();
    await server.answer(0, 'a');
    await clock.setVisible(false);
    await clock.advance(10_000); // the timer falls due while hidden: no request
    await clock.advance(300_000);
    expect(server.calls).toHaveLength(1);
    await clock.setVisible(true);
    expect(server.calls).toHaveLength(2); // at once, not at the next interval
    await server.answer(1, 'b');
    poller.stop();
  });

  it('does not refresh again when the tab comes back right after a refresh', async () => {
    const { clock, server, poller } = setup({ minGapMs: 2_000 });
    poller.start();
    await server.answer(0, 'a');
    await clock.advance(1_000);
    await clock.setVisible(false);
    await clock.setVisible(true);
    expect(server.calls).toHaveLength(1); // only a second since the last request
    await clock.advance(9_000);
    expect(server.calls).toHaveLength(2); // the normal schedule carries on
    poller.stop();
  });

  it('waits for the tab to be shown when it is started hidden', async () => {
    const { clock, server, poller } = setup({ startVisible: false });
    poller.start();
    await clock.advance(60_000);
    expect(server.calls).toHaveLength(0);
    await clock.setVisible(true);
    expect(server.calls).toHaveLength(1);
    poller.stop();
  });

  it('a window gaining focus counts the same as the tab being shown', async () => {
    const { clock, server, poller } = setup();
    poller.start();
    await server.answer(0, 'a');
    await clock.advance(5_000);
    await clock.setVisible(true); // the listener is called again, as a focus event would
    expect(server.calls).toHaveLength(2);
    poller.stop();
  });
});

describe('createPoller: failures', () => {
  it('reports the error, keeps what was shown, slows down (doubling, up to a cap), and speeds up again after one success', async () => {
    const { clock, server, data, errors, poller } = setup();
    poller.start();
    await server.answer(0, 'good');
    await clock.advance(10_000);
    await server.fail(1);
    expect(errors).toEqual(['down']);
    expect(data).toEqual(['good']); // nothing replaced the last good answer
    await clock.advance(19_999);
    expect(server.calls).toHaveLength(2);
    await clock.advance(1); // 20 s after the first failure
    expect(server.calls).toHaveLength(3);
    await server.fail(2);
    await clock.advance(40_000);
    expect(server.calls).toHaveLength(4);
    await server.fail(3);
    await clock.advance(60_000); // 80 s would be next, but the cap is a minute
    expect(server.calls).toHaveLength(5);
    await server.answer(4, 'recovered');
    await clock.advance(10_000); // back to the normal pace
    expect(server.calls).toHaveLength(6);
    expect(data).toEqual(['good', 'recovered']);
    poller.stop();
  });
});

describe('createPoller: stopping and refreshing', () => {
  it('stop() ends the timers and the listening, and an answer that arrives afterwards is thrown away', async () => {
    const { clock, server, data, poller } = setup();
    poller.start();
    expect(clock.listening()).toBe(1);
    poller.stop();
    expect(clock.listening()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    await server.answer(0, 'too late');
    expect(data).toEqual([]);
    await clock.advance(100_000);
    expect(server.calls).toHaveLength(1);
  });

  it('can be started again after stopping, with a fresh request', async () => {
    const { server, data, poller } = setup();
    poller.start();
    poller.stop();
    poller.start();
    expect(server.calls).toHaveLength(2);
    await server.answer(0, 'old'); // the first run's answer is ignored
    await server.answer(1, 'new');
    expect(data).toEqual(['new']);
    poller.stop();
  });

  it('refresh() joins the request already running instead of starting another', async () => {
    const { server, poller } = setup();
    poller.start();
    const joined = poller.refresh();
    expect(server.calls).toHaveLength(1);
    await server.answer(0, 'a');
    await joined;
    poller.stop();
  });

  it('refreshFresh() always starts a new request after the call, even when one is running (for use right after the person changed something)', async () => {
    const { server, data, poller } = setup();
    poller.start();
    const fresh = poller.refreshFresh();
    expect(server.calls).toHaveLength(1);
    await server.answer(0, 'before the change');
    await flush();
    expect(server.calls).toHaveLength(2);
    await server.answer(1, 'after the change');
    await fresh;
    expect(data).toEqual(['before the change', 'after the change']);
    poller.stop();
  });

  it('does nothing when asked to refresh after stopping', async () => {
    const { server, poller } = setup();
    poller.start();
    poller.stop();
    await poller.refresh();
    await poller.refreshFresh();
    expect(server.calls).toHaveLength(1);
  });
});

describe('isStale', () => {
  it('is false before there has been any answer, and while the last answer is recent', () => {
    expect(isStale(null, 1_000_000, 10_000)).toBe(false);
    expect(isStale(1_000_000, 1_020_000, 10_000)).toBe(false);
  });

  it('becomes true after three polls, and never sooner than 30 seconds', () => {
    expect(isStale(1_000_000, 1_031_000, 10_000)).toBe(true);
    expect(isStale(1_000_000, 1_029_000, 5_000)).toBe(false);
    expect(isStale(1_000_000, 1_061_000, 20_000)).toBe(true);
    expect(isStale(1_000_000, 1_059_000, 20_000)).toBe(false);
  });
});
