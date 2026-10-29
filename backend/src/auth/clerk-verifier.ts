import { createClerkClient, verifyToken } from '@clerk/backend';
import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ClerkConfig } from '../config.js';

/** What the rest of the backend needs from Clerk. Swapped for a fake in tests so no network or real keys are needed. */
export interface ClerkVerifier {
  readonly enabled: boolean;
  /**
   * The Clerk user id when `token` is a genuine, unexpired Clerk session token issued for one of our allowed origins.
   * Anything else (bad signature, expired, wrong origin, a network problem) returns null, so a failure never lets anyone in.
   */
  verifySessionToken(token: string): Promise<string | null>;
  /** The person's VERIFIED email addresses, lower-case, primary first. An address Clerk has not verified is never returned. */
  getVerifiedEmails(clerkUserId: string): Promise<string[]>;
}

export const CLERK_VERIFIER = Symbol('CLERK_VERIFIER');

interface ClerkUserEmails {
  primaryEmailAddressId: string | null;
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
}

/** Only addresses Clerk marks as verified, lower-cased, with the primary one first and no duplicates. */
export function verifiedEmailsOf(user: ClerkUserEmails): string[] {
  const verified = user.emailAddresses.filter((email) => email.verification?.status === 'verified');
  const ordered = [
    ...verified.filter((email) => email.id === user.primaryEmailAddressId),
    ...verified.filter((email) => email.id !== user.primaryEmailAddressId),
  ];
  return [...new Set(ordered.map((email) => email.emailAddress.trim().toLowerCase()))];
}

/** Failures caused by this server's own Clerk setup (wrong or missing keys, signing keys unreachable), not by the person's token. */
const SERVER_SETUP_REASONS = new Set([
  'secret-key-invalid',
  'jwk-local-missing',
  'jwk-remote-failed-to-load',
  'jwk-remote-invalid',
  'jwk-remote-missing',
  'jwk-failed-to-resolve',
]);

/** Pulls Clerk's machine-readable reason codes out of a failed verification. They describe the failure, never the token or keys. */
export function failureReasons(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => (error as { reason?: unknown }).reason).filter((reason): reason is string => typeof reason === 'string');
}

/**
 * Non-secret facts about a token for diagnosing a rejection: which origin it says it was issued for and how long it has left.
 * Reads the payload without trusting it and never returns the token, the signature or any other claim.
 */
export function tokenDiagnostics(token: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { azp?: unknown; exp?: unknown };
    const azp = typeof payload.azp === 'string' && payload.azp.length <= 200 ? payload.azp : 'none';
    const expiresIn = typeof payload.exp === 'number' ? `${payload.exp - nowSeconds}s` : 'unknown';
    return `azp=${azp}, expires in ${expiresIn}`;
  } catch {
    return 'token payload unreadable';
  }
}

/** In development only, the rejection reason codes are added to the 401 body so they show in the browser. Never in production. */
export function devRejectionReasons(reasons: readonly string[], production: boolean): string | undefined {
  return production || reasons.length === 0 ? undefined : reasons.join(',');
}

/** True when the failure is the server's fault, so the person should be told sign-in is unavailable instead of "session expired". */
export function isServerSetupFailure(reasons: readonly string[]): boolean {
  return reasons.some((reason) => SERVER_SETUP_REASONS.has(reason));
}

class ClerkBackendVerifier implements ClerkVerifier {
  readonly enabled = true;
  private readonly logger = new Logger('Clerk');
  private readonly client;

  constructor(private readonly config: ClerkConfig) {
    this.client = createClerkClient({ secretKey: config.secretKey });
  }

  async verifySessionToken(token: string): Promise<string | null> {
    try {
      // @clerk/backend's verifyToken returns the verified payload itself and THROWS when anything is wrong (bad signature,
      // expired, wrong origin, unusable keys). A thrown error is therefore the only way a token is refused.
      const payload = await verifyToken(token, {
        secretKey: this.config.secretKey,
        ...(this.config.jwtKey ? { jwtKey: this.config.jwtKey } : {}),
        authorizedParties: this.config.authorizedParties,
      });
      const subject = (payload as { sub?: unknown } | undefined)?.sub;
      return typeof subject === 'string' && subject.length > 0 ? subject : this.fail(['no-subject-claim'], token);
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof UnauthorizedException) throw error;
      const reasons = failureReasons([error]);
      return this.fail(reasons.length > 0 ? reasons : [`threw-${(error as Error)?.name ?? 'unknown'}`], token);
    }
  }

  /** Always refuses. A problem with our own Clerk setup is reported as such; anything else is just a rejected token. */
  private fail(reasons: string[], token: string): null {
    if (isServerSetupFailure(reasons)) {
      this.logger.error(
        `Clerk could not verify a token because of this server's Clerk setup (${reasons.join(', ')}). Check that CLERK_SECRET_KEY belongs to the same Clerk instance as the publishable key.`,
      );
      throw new ServiceUnavailableException('Sign-in is temporarily unavailable because the server is not set up correctly for Clerk.');
    }
    this.logger.warn(
      `Rejected a Clerk token (${reasons.join(', ')}); ${tokenDiagnostics(token)}; allowed origins: ${this.config.authorizedParties.join(', ')}.`,
    );
    const reason = devRejectionReasons(reasons, process.env.NODE_ENV === 'production');
    if (reason) {
      throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: 'Your session has expired. Please sign in again.', reason });
    }
    return null;
  }

  async getVerifiedEmails(clerkUserId: string): Promise<string[]> {
    return verifiedEmailsOf(await this.client.users.getUser(clerkUserId));
  }
}

/** Used when CLERK_SECRET_KEY is not set: Clerk sign-in is simply unavailable and the legacy login carries on alone. */
class DisabledClerkVerifier implements ClerkVerifier {
  readonly enabled = false;
  async verifySessionToken(): Promise<string | null> {
    return null;
  }
  async getVerifiedEmails(): Promise<string[]> {
    return [];
  }
}

/** Why a secret key cannot be a real Clerk key (a shortened "sk_test_…" copied from a dashboard, stray quotes), or null if it looks fine. */
export function secretKeyProblem(key: string): string | null {
  if (/[^ -~]/.test(key)) return 'it contains a non-ASCII character such as "…" (a shortened copy, not the full key)';
  if (!/^sk_(test|live)_[A-Za-z0-9]{20,}$/.test(key)) return 'it must start with sk_test_ or sk_live_ and be the full key, with no quotes or spaces';
  return null;
}

export function createClerkVerifier(config: ClerkConfig): ClerkVerifier {
  if (!config.enabled) return new DisabledClerkVerifier();
  const problem = secretKeyProblem(config.secretKey);
  if (problem) new Logger('Clerk').error(`CLERK_SECRET_KEY looks wrong: ${problem}. Clerk sign-in will not work until it is fixed.`);
  return new ClerkBackendVerifier(config);
}
