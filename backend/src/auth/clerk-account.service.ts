import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ExternalIdentity, User } from '../database/entities/index.js';
import { isUniqueViolation } from '../database/errors.js';
import { createAccount, type ProfileInput } from './account-creation.js';
import { CLERK_VERIFIER, type ClerkVerifier } from './clerk-verifier.js';
import { CLERK_PROVIDER, IdentityService } from './identity.service.js';
import { verifyPassword } from './password.js';
import { toPublicUser, type PublicUser } from './session.js';

/** Where a Clerk sign-in stands with respect to a CareSlot account. */
export type ClerkAccountStatus =
  | { state: 'LINKED'; user: PublicUser }
  | { state: 'ONBOARDING_REQUIRED'; email: string }
  /** A CareSlot account with the same verified email exists but is NOT linked: the person must prove it is theirs. */
  | { state: 'LINK_REQUIRED'; email: string }
  /** More than one possible account, or the account already belongs to another sign-in: nothing is done automatically. */
  | { state: 'CONFLICT'; email: string }
  | { state: 'EMAIL_UNVERIFIED' };

/** What the verified emails of a Clerk user match among CareSlot accounts. */
export type AccountMatch = { userId: string; linkedToClerkUserId: string | null }[];

/**
 * Decides what to do with a Clerk sign-in that has no link yet. It is deliberately cautious: it never links anything by
 * itself, and anything ambiguous is left for a human to sort out.
 */
export function classifyMatches(matches: AccountMatch, ownClerkUserId: string): 'NONE' | 'LINKABLE' | 'CONFLICT' {
  if (matches.length === 0) return 'NONE';
  // Several different CareSlot accounts match this person's emails: ambiguous, so never guess.
  if (new Set(matches.map((match) => match.userId)).size > 1) return 'CONFLICT';
  const [match] = matches;
  // The account is already tied to a different Clerk sign-in.
  if (match.linkedToClerkUserId && match.linkedToClerkUserId !== ownClerkUserId) return 'CONFLICT';
  return 'LINKABLE';
}

/**
 * Connects a Clerk sign-in to a CareSlot account, safely:
 * - the email must be one Clerk has VERIFIED;
 * - a new account is only created when no account uses that email (never a duplicate, never a silent merge);
 * - an existing account is only linked after the person proves they own it by entering its current password;
 * - roles come from the sign-up form's PATIENT/DOCTOR choice or the existing row, never from Clerk or a token.
 */
const MAX_LINK_ATTEMPTS = 5;
const LINK_LOCK_MS = 15 * 60_000;

@Injectable()
export class ClerkAccountService {
  /** Wrong-password attempts per Clerk user, so linking cannot be used to guess someone's password. Per server process. */
  private readonly failedLinks = new Map<string, { count: number; until: number }>();

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(ExternalIdentity) private readonly identities: Repository<ExternalIdentity>,
    private readonly dataSource: DataSource,
    private readonly identity: IdentityService,
    @Inject(CLERK_VERIFIER) private readonly clerk: ClerkVerifier,
  ) {}

  async status(clerkUserId: string): Promise<ClerkAccountStatus> {
    const linked = await this.identity.findUserByClerkId(clerkUserId);
    if (linked) {
      const user = await this.users.findOneByOrFail({ id: linked.id });
      return { state: 'LINKED', user: toPublicUser(user) };
    }

    const emails = await this.verifiedEmails(clerkUserId);
    if (emails.length === 0) return { state: 'EMAIL_UNVERIFIED' };

    const matches = await this.accountsWithEmails(emails);
    const verdict = classifyMatches(matches, clerkUserId);
    if (verdict === 'LINKABLE') return { state: 'LINK_REQUIRED', email: emails[0] };
    if (verdict === 'CONFLICT') return { state: 'CONFLICT', email: emails[0] };
    return { state: 'ONBOARDING_REQUIRED', email: emails[0] };
  }

  /** Creates a brand-new CareSlot account for this Clerk sign-in. Refuses if the email already has an account. */
  async completeProfile(clerkUserId: string, input: ProfileInput): Promise<{ user: PublicUser }> {
    const status = await this.status(clerkUserId);
    if (status.state === 'LINKED') throw new ConflictException('This sign-in already has a CareSlot account.');
    if (status.state === 'EMAIL_UNVERIFIED') throw new ForbiddenException('Please verify your email address with Clerk first.');
    if (status.state === 'LINK_REQUIRED' || status.state === 'CONFLICT') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'A CareSlot account with this email already exists. Link it with its password instead of creating a new one.',
        code: 'ACCOUNT_LINK_REQUIRED',
      });
    }

    try {
      const user = await this.dataSource.transaction(async (manager) => {
        const created = await createAccount(manager, { email: status.email, passwordHash: null, input });
        await manager.insert(ExternalIdentity, { provider: CLERK_PROVIDER, externalId: clerkUserId, userId: created.id });
        return created;
      });
      return { user: toPublicUser(user) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A CareSlot account for this email or sign-in already exists. Please try again.');
      }
      throw error;
    }
  }

  /**
   * Links an existing CareSlot account to this Clerk sign-in. Both must hold: Clerk has verified an email that matches the
   * account, AND the person supplies the account's current password. Neither alone is enough.
   */
  async link(clerkUserId: string, password: string): Promise<{ user: PublicUser }> {
    this.assertNotLocked(clerkUserId);
    const emails = await this.verifiedEmails(clerkUserId);
    if (emails.length === 0) throw new ForbiddenException('Please verify your email address with Clerk first.');
    if (await this.identity.findUserByClerkId(clerkUserId)) {
      throw new ConflictException('This sign-in is already linked to a CareSlot account.');
    }

    const candidates = await this.usersWithEmails(emails);
    if (candidates.length === 0) throw new NotFoundException('No existing CareSlot account uses your verified email.');
    if (candidates.length > 1) {
      throw new ConflictException('More than one CareSlot account matches your email, so it cannot be linked automatically.');
    }
    const [account] = candidates;

    // Accounts that never had a password (or whose password cannot be checked) cannot be proven this way.
    if (!account.passwordHash) {
      throw new ConflictException('This account has no password to confirm it with, so it cannot be linked automatically.');
    }
    if (!(await verifyPassword(password, account.passwordHash))) {
      this.recordFailure(clerkUserId);
      throw new UnauthorizedException('That password is not correct for the existing account.');
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        // Another sign-in may have claimed this account in the meantime: the unique constraints decide, not a check-then-write.
        await manager.insert(ExternalIdentity, { provider: CLERK_PROVIDER, externalId: clerkUserId, userId: account.id });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This account is already linked to a sign-in, or this sign-in is already linked.');
      }
      throw error;
    }
    this.failedLinks.delete(clerkUserId);
    return { user: toPublicUser(account) };
  }

  private recordFailure(clerkUserId: string): void {
    const now = Date.now();
    const current = this.failedLinks.get(clerkUserId);
    const active = current && current.until > now ? current : null;
    this.failedLinks.set(clerkUserId, { count: (active?.count ?? 0) + 1, until: active?.until ?? now + LINK_LOCK_MS });
  }

  private assertNotLocked(clerkUserId: string): void {
    const entry = this.failedLinks.get(clerkUserId);
    if (entry && entry.until > Date.now() && entry.count >= MAX_LINK_ATTEMPTS) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: 'Too many incorrect passwords. Please wait 15 minutes and try again.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async verifiedEmails(clerkUserId: string): Promise<string[]> {
    try {
      return await this.clerk.getVerifiedEmails(clerkUserId);
    } catch {
      throw new ServiceUnavailableException('We could not reach Clerk to check your email. Please try again in a moment.');
    }
  }

  private usersWithEmails(emails: string[]): Promise<User[]> {
    return this.users.createQueryBuilder('user').where('lower(user.email) IN (:...emails)', { emails }).getMany();
  }

  private async accountsWithEmails(emails: string[]): Promise<AccountMatch> {
    const found = await this.usersWithEmails(emails);
    if (found.length === 0) return [];
    const links = await this.identities.find({ where: found.map((user) => ({ provider: CLERK_PROVIDER, userId: user.id })) });
    return found.map((user) => ({
      userId: user.id,
      linkedToClerkUserId: links.find((link) => link.userId === user.id)?.externalId ?? null,
    }));
  }
}
