'use client';

import { BellIcon, CalendarCheckIcon, CalendarClockIcon, LayoutDashboardIcon, ReceiptIcon, SearchIcon, UserRoundIcon, type LucideIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useHydrated, useSession } from '@/lib/session';
import type { Role } from '@/lib/types';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}

interface NavDefinition {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Which paths belong to this item, so the booking pages still highlight "Find doctors". */
  match: (path: string) => boolean;
}

const NAV: Partial<Record<Role, NavDefinition[]>> = {
  // Sign out is the last item of the patient sidebar too; it is an action, not a page, so the sidebar adds it itself.
  PATIENT: [
    { href: '/', label: 'Find Doctors', icon: SearchIcon, match: (p) => p === '/' || p.startsWith('/doctors') },
    { href: '/appointments', label: 'My Appointments', icon: CalendarCheckIcon, match: (p) => p.startsWith('/appointments') },
    { href: '/payments', label: 'Payments & Receipts', icon: ReceiptIcon, match: (p) => p.startsWith('/payments') },
    { href: '/notifications', label: 'Notifications', icon: BellIcon, match: (p) => p.startsWith('/notifications') },
    { href: '/profile', label: 'My Profile', icon: UserRoundIcon, match: (p) => p.startsWith('/profile') },
  ],
  DOCTOR: [
    { href: '/doctor', label: 'Dashboard', icon: LayoutDashboardIcon, match: (p) => p === '/doctor' },
    { href: '/doctor/appointments', label: 'Appointments', icon: CalendarCheckIcon, match: (p) => p.startsWith('/doctor/appointments') },
    { href: '/doctor/availability', label: 'Availability', icon: CalendarClockIcon, match: (p) => p.startsWith('/doctor/availability') },
    { href: '/doctor/profile', label: 'Profile', icon: UserRoundIcon, match: (p) => p.startsWith('/doctor/profile') },
  ],
};

/** The workspace navigation for the signed-in user's role. Empty when signed out (or for roles without a workspace yet). */
export function useNavItems(): NavItem[] {
  const hydrated = useHydrated();
  const session = useSession();
  const pathname = usePathname();
  if (!hydrated || !session) return [];
  return (NAV[session.user.role] ?? []).map(({ match, ...item }) => ({ ...item, active: match(pathname) }));
}
