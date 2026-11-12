import { describe, expect, it, vi } from 'vitest';
import { RequestTimeoutError, fetchWithTimeout } from './fetch-timeout';

/** A fetch that never answers, but ends with the signal's own error when its time limit passes (as a real fetch does). */
const neverAnswers = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;

describe('fetchWithTimeout', () => {
  it('is plain fetch when no limit is given (the request is left alone)', async () => {
    const answer = new Response('ok');
    const fetchFn = vi.fn(async () => answer) as unknown as typeof fetch;
    await expect(fetchWithTimeout(fetchFn, '/x', { method: 'POST' })).resolves.toBe(answer);
    expect(vi.mocked(fetchFn).mock.calls[0][1]).toEqual({ method: 'POST' }); // no signal added
  });

  it('returns the answer when it comes in time', async () => {
    const answer = new Response('ok');
    await expect(fetchWithTimeout(vi.fn(async () => answer) as unknown as typeof fetch, '/x', {}, 5000)).resolves.toBe(answer);
  });

  it('gives up with a clear error when the request does not finish in time', async () => {
    const started = Date.now();
    await expect(fetchWithTimeout(neverAnswers, '/x', {}, 60)).rejects.toBeInstanceOf(RequestTimeoutError); // a real (short) limit: Node's AbortSignal.timeout does not use fake timers
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not turn an ordinary network failure into a timeout', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchWithTimeout(failing, '/x', {}, 5000)).rejects.toThrow('Failed to fetch');
  });
});
