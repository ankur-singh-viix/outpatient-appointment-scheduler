import { codeMatches, generateCode, hashCode, MAX_CODE_ATTEMPTS, normalizeEmail, RESEND_SECONDS, resendWaitSeconds } from './verification.js';

describe('verification codes', () => {
  it('generates 6-digit numeric codes, keeping leading zeros', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it('does not always return the same code', () => {
    expect(new Set(Array.from({ length: 50 }, generateCode)).size).toBeGreaterThan(1);
  });

  it('accepts the right code for the right email and secret only', () => {
    const stored = hashCode('123456', 'a@b.com', 'secret');
    expect(codeMatches('123456', 'a@b.com', 'secret', stored)).toBe(true);
    expect(codeMatches('123457', 'a@b.com', 'secret', stored)).toBe(false);
    expect(codeMatches('123456', 'other@b.com', 'secret', stored)).toBe(false);
    expect(codeMatches('123456', 'a@b.com', 'another-secret', stored)).toBe(false);
  });

  it('never stores the code itself and rejects a malformed stored hash', () => {
    expect(hashCode('123456', 'a@b.com', 'secret')).not.toContain('123456');
    expect(codeMatches('123456', 'a@b.com', 'secret', 'not-hex')).toBe(false);
    expect(codeMatches('123456', 'a@b.com', 'secret', '')).toBe(false);
  });

  it('normalises emails to trimmed lower case', () => {
    expect(normalizeEmail('  Ankur@Example.COM ')).toBe('ankur@example.com');
  });

  it('counts down the resend wait and then allows sending again', () => {
    const sent = new Date('2026-11-01T10:00:00Z');
    expect(resendWaitSeconds(sent, new Date('2026-11-01T10:00:00Z'))).toBe(RESEND_SECONDS);
    expect(resendWaitSeconds(sent, new Date('2026-11-01T10:00:10Z'))).toBe(RESEND_SECONDS - 10);
    expect(resendWaitSeconds(sent, new Date('2026-11-01T10:00:30Z'))).toBe(0);
    expect(resendWaitSeconds(sent, new Date('2026-11-01T10:05:00Z'))).toBe(0);
  });

  it('allows a small, fixed number of guesses per code', () => {
    expect(MAX_CODE_ATTEMPTS).toBe(5);
  });
});
