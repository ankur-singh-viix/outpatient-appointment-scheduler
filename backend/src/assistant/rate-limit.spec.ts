import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to the limit in the window, then says how long to wait, per key', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect([1, 2, 3].map((n) => limiter.take('a', n * 1000).allowed)).toEqual([true, true, true]);
    const refused = limiter.take('a', 10_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 51 }); // the first use (at 1s) leaves the window at 61s
    expect(limiter.take('b', 10_000).allowed).toBe(true); // another person is not affected
  });

  it('does not count refusals, and frees places as old uses leave the window', () => {
    const limiter = new RateLimiter(2, 10_000);
    limiter.take('a', 0);
    limiter.take('a', 1000);
    for (let n = 0; n < 5; n++) expect(limiter.take('a', 2000).allowed).toBe(false);
    expect(limiter.take('a', 10_500).allowed).toBe(true); // the use at 0s has expired; refusals never counted
    expect(limiter.take('a', 10_600).allowed).toBe(false); // 1s and 10.5s are still inside
    expect(limiter.take('a', 11_100).allowed).toBe(true);
  });
});
