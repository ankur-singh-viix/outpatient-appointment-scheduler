import type { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(request: Request): string | null {
  const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
  return scheme === 'Bearer' && token ? token : null;
}

/**
 * Legacy CareSlot tokens are signed with our own secret (HS256). Clerk session tokens use a different algorithm.
 * The algorithm decides which verifier gets the token, and each verifier still checks the signature itself, so a token
 * of one kind can never pass as the other (and "alg: none" goes down the Clerk path, where it fails).
 */
export function isLegacyToken(jwt: JwtService, token: string): boolean {
  const decoded = jwt.decode(token, { complete: true }) as { header?: { alg?: string } } | null;
  return decoded?.header?.alg === 'HS256';
}
