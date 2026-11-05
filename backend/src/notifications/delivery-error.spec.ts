import { DeliveryError, isRetryable, isRetryableStatus } from './delivery-error.js';
import { backoffSeconds } from './notifications.service.js';

describe('which failures are worth retrying', () => {
  it('retries timeouts, rate limits and provider outages, but not refusals', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) expect(isRetryableStatus(status)).toBe(false);
  });

  it('follows the DeliveryError flag, and retries an unknown error rather than giving up on a guess', () => {
    expect(isRetryable(new DeliveryError('down', true))).toBe(true);
    expect(isRetryable(new DeliveryError('refused', false))).toBe(false);
    expect(isRetryable(new Error('something else'))).toBe(true);
    expect(isRetryable('text')).toBe(true);
  });
});

describe('backoffSeconds', () => {
  it('doubles the wait after each failure, from the base', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => backoffSeconds(attempt, 60))).toEqual([60, 120, 240, 480, 960]);
  });

  it('never waits longer than an hour', () => {
    expect(backoffSeconds(7, 60)).toBe(3600);
    expect(backoffSeconds(30, 60)).toBe(3600);
  });

  it('follows the configured base', () => {
    expect([1, 2, 3].map((attempt) => backoffSeconds(attempt, 5))).toEqual([5, 10, 20]);
  });

  it('treats a count below one as the first failure', () => {
    expect(backoffSeconds(0, 60)).toBe(60);
  });
});
