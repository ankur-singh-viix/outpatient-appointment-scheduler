import type { Request } from 'express';

export const ROLES = ['PATIENT', 'DOCTOR', 'RECEPTIONIST', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** The signed-in user, taken from a verified JWT. */
export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  name: string;
  role: Role;
}

/** A verified Clerk sign-in. It proves who the person is to Clerk, nothing about their CareSlot role. */
export interface ClerkSignIn {
  clerkUserId: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  clerk?: ClerkSignIn;
}
