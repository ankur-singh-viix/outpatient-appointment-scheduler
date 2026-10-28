import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_MINUTES = 15;
/** Wrong guesses allowed against one code. Asking for a new code starts over with a fresh random code. */
export const MAX_CODE_ATTEMPTS = 5;
/** Minimum gap between two emails to the same address. */
export const RESEND_SECONDS = 30;
export const SIGNUP_TOKEN_MINUTES = 30;

/** A random 6-digit code, zero-padded ("004217"). */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Keyed hash of the code, bound to the email, so a stolen database row does not reveal the code. */
export function hashCode(code: string, email: string, secret: string): string {
  return createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
}

export function codeMatches(code: string, email: string, secret: string, storedHash: string): boolean {
  const actual = Buffer.from(hashCode(code, email, secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** How many whole seconds are left before another email may be sent (0 = go ahead). */
export function resendWaitSeconds(lastSentAt: Date, now = new Date()): number {
  const elapsed = Math.floor((now.getTime() - lastSentAt.getTime()) / 1000);
  return Math.max(RESEND_SECONDS - elapsed, 0);
}
