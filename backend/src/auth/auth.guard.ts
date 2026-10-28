import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ROLES_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest, JwtPayload, Role } from './auth.types.js';

/**
 * Requires a valid `Authorization: Bearer <jwt>` header, then, if the route has
 * @Roles(...), requires the user's role to be one of them.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Please sign in to continue.');

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
    request.user = { id: payload.sub, name: payload.name, role: payload.role };

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed && !allowed.includes(payload.role)) {
      throw new ForbiddenException(`This action is only available to: ${allowed.join(', ').toLowerCase()}.`);
    }
    return true;
  }
}
