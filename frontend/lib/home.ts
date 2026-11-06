import type { Role } from '@/lib/types';

/** Where a signed-in person lands: their own workspace. Every way of signing in uses this, so no role is sent to the wrong place. */
export function homeFor(role: Role): string {
  switch (role) {
    case 'DOCTOR':
      return '/doctor';
    case 'RECEPTIONIST':
      return '/reception';
    case 'ADMIN':
      return '/admin/receptionists';
    default:
      return '/dashboard';
  }
}
