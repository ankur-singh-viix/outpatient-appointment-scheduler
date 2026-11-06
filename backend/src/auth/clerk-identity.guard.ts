import { CanActivate, ExecutionContext, Inject, Injectable, Logger, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthenticatedRequest, ClerkSignIn } from './auth.types.js';
import { CLERK_VERIFIER, type ClerkVerifier } from './clerk-verifier.js';
import { bearerToken, isLegacyToken } from './tokens.js';

/**
 * For the few endpoints a person needs BEFORE they have a CareSlot account (check status, finish the profile, link an old
 * account). It only proves who they are to Clerk. It grants no CareSlot role and no access to any other endpoint.
 */
@Injectable()
export class ClerkIdentityGuard implements CanActivate {
  private readonly logger = new Logger('ClerkIdentity');

  constructor(
    private readonly jwt: JwtService,
    @Inject(CLERK_VERIFIER) private readonly clerk: ClerkVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request);
    // Legacy tokens have nothing to do with Clerk sign-in; refuse them here rather than guess.
    // Diagnostics only record which branch refused the request and whether a Bearer header arrived, never any of its content.
    if (!token) {
      this.logger.warn(`401 ${request.method} ${request.path}: no "Authorization: Bearer" header (header present: ${Boolean(request.headers.authorization)}).`);
      throw new UnauthorizedException('Please sign in with Clerk to continue.');
    }
    if (isLegacyToken(this.jwt, token)) {
      this.logger.warn(`401 ${request.method} ${request.path}: the Bearer token is a legacy CareSlot token, not a Clerk one.`);
      throw new UnauthorizedException('Please sign in with Clerk to continue.');
    }
    // A Clerk token reached a server that has Clerk switched off: the server never got a (valid) CLERK_SECRET_KEY, or was not restarted after it was added.
    if (!this.clerk.enabled) {
      this.logger.warn(`401 ${request.method} ${request.path}: a Bearer token arrived but Clerk is switched off on this server.`);
      throw new UnauthorizedException('Clerk sign-in is not turned on for this server. Set CLERK_SECRET_KEY in the backend settings and restart it.');
    }
    const clerkUserId = await this.clerk.verifySessionToken(token);
    if (!clerkUserId) {
      // The verifier has already logged the reason code just above this line.
      this.logger.warn(`401 ${request.method} ${request.path}: a Bearer token arrived but did not verify.`);
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
    request.clerk = { clerkUserId };
    return true;
  }
}

/** Injects the verified Clerk sign-in that ClerkIdentityGuard attached to the request. */
export const ClerkSignInParam = createParamDecorator((_data: unknown, ctx: ExecutionContext): ClerkSignIn => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().clerk!;
});
