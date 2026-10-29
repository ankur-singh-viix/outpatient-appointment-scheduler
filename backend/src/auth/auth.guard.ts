import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ROLES_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest, AuthUser, JwtPayload, Role } from './auth.types.js';
import { CLERK_VERIFIER, type ClerkVerifier } from './clerk-verifier.js';
import { IdentityService } from './identity.service.js';
import { bearerToken, isLegacyToken } from './tokens.js';

/**
 * Requires a valid `Authorization: Bearer <token>` header, then, if the route has @Roles(...), requires the user's role
 * to be one of them. The token is either a legacy CareSlot token or a Clerk session token linked to a CareSlot user.
 * Either way the role comes from our own users table (never from the token's claims or from Clerk), and the controllers
 * receive the same `{ id, name, role }`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    @Inject(CLERK_VERIFIER) private readonly clerk: ClerkVerifier,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request);
    if (!token) throw new UnauthorizedException('Please sign in to continue.');

    const user = isLegacyToken(this.jwt, token) ? await this.legacyUser(token) : await this.clerkUser(token);
    request.user = user;

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed && !allowed.includes(user.role)) {
      throw new ForbiddenException(`This action is only available to: ${allowed.join(', ').toLowerCase()}.`);
    }
    return true;
  }

  private async legacyUser(token: string): Promise<AuthUser> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
    // Tokens issued during sign-up carry a `purpose` and no user. They must never work as a session.
    if (!payload.sub || !payload.role || 'purpose' in payload) {
      throw new UnauthorizedException('Please sign in to continue.');
    }
    return { id: payload.sub, name: payload.name, role: payload.role };
  }

  private async clerkUser(token: string): Promise<AuthUser> {
    if (!this.clerk.enabled) throw new UnauthorizedException('Please sign in to continue.');
    const clerkUserId = await this.clerk.verifySessionToken(token);
    if (!clerkUserId) throw new UnauthorizedException('Your session has expired. Please sign in again.');

    const user = await this.identity.findUserByClerkId(clerkUserId);
    if (!user) {
      // Signed in with Clerk, but no CareSlot account is linked yet. The app sends them to finish setting up.
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Finish setting up your CareSlot profile to continue.',
        code: 'PROFILE_REQUIRED',
      });
    }
    return user;
  }
}
