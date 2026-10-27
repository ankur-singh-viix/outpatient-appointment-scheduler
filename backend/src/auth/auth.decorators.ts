import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthenticatedRequest, AuthUser, Role } from './auth.types.js';

export const ROLES_KEY = 'roles';

/** Restricts a controller or route to the given roles. Use together with AuthGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Injects the user that AuthGuard attached to the request. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.user!;
});
