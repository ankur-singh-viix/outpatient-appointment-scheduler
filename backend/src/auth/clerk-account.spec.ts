import { classifyMatches } from './clerk-account.service.js';

const CLERK_ME = 'user_me';

describe('classifyMatches (what to do with a Clerk sign-in that has no link yet)', () => {
  it('lets a new person create a profile when no account uses their verified email', () => {
    expect(classifyMatches([], CLERK_ME)).toBe('NONE');
  });

  it('asks an existing account holder to link, and never links by itself', () => {
    expect(classifyMatches([{ userId: 'u1', linkedToClerkUserId: null }], CLERK_ME)).toBe('LINKABLE');
  });

  it('treats an account already tied to this same Clerk user as linkable (nothing to conflict with)', () => {
    expect(classifyMatches([{ userId: 'u1', linkedToClerkUserId: CLERK_ME }], CLERK_ME)).toBe('LINKABLE');
  });

  it('blocks an account that already belongs to a different Clerk sign-in', () => {
    expect(classifyMatches([{ userId: 'u1', linkedToClerkUserId: 'user_someone_else' }], CLERK_ME)).toBe('CONFLICT');
  });

  it('blocks the case where several different accounts match, rather than guess', () => {
    const matches = [
      { userId: 'u1', linkedToClerkUserId: null },
      { userId: 'u2', linkedToClerkUserId: null },
    ];
    expect(classifyMatches(matches, CLERK_ME)).toBe('CONFLICT');
  });

  it('is not confused by one account matched through two of the person’s emails', () => {
    const matches = [
      { userId: 'u1', linkedToClerkUserId: null },
      { userId: 'u1', linkedToClerkUserId: null },
    ];
    expect(classifyMatches(matches, CLERK_ME)).toBe('LINKABLE');
  });
});
