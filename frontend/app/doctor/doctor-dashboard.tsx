'use client';

import { CalendarCheckIcon, CalendarClockIcon, ClipboardPlusIcon } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { cn } from '@/lib/utils';
import type { Session } from '@/lib/types';
import { DoctorQueuePanel } from './queue-panel';

export function DoctorDashboard() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor">
      {(session) => <Overview session={session} />}
    </RequireRole>
  );
}

const NAV_LINKS = [
  { href: '/doctor/appointments', title: 'Appointments', icon: CalendarCheckIcon },
  { href: '/doctor/availability', title: 'Availability', icon: CalendarClockIcon },
  { href: '/doctor/prescriptions', title: 'Prescriptions', icon: ClipboardPlusIcon },
];

function Overview({ session }: { session: Session }) {
  return (
    <div className="space-y-6 animate-in fade-in-0 duration-300">
      <PageHeader title={`Welcome back, ${session.user.name}`} description="Today's live consultation queue." />

      <DoctorQueuePanel session={session} />

      <nav aria-label="Doctor tools" className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t pt-4 text-sm">
        {NAV_LINKS.map((item, index) => (
          <span key={item.href} className="flex items-center gap-1">
            {index > 0 && <span className="mx-1 text-muted-foreground" aria-hidden>|</span>}
            <Link
              href={item.href}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-foreground',
                'hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            >
              <item.icon className="size-3.5 text-muted-foreground" aria-hidden />
              {item.title}
            </Link>
          </span>
        ))}
      </nav>
    </div>
  );
}
