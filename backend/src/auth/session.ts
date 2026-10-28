import type { JwtService } from '@nestjs/jwt';
import type { User } from '../database/entities/index.js';
import type { JwtPayload, Role } from './auth.types.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/** The response of a successful sign-in: a JWT and the public view of the user. */
export async function signSession(jwt: JwtService, user: User): Promise<{ accessToken: string; user: PublicUser }> {
  const payload: JwtPayload = { sub: user.id, name: user.name, role: user.role };
  return { accessToken: await jwt.signAsync(payload), user: toPublicUser(user) };
}
