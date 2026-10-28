'use client';

import Link from 'next/link';
import { useNavItems } from '@/components/nav';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/** The persistent left workspace sidebar. Large screens only; phones get the strip under the top bar instead. */
export function Sidebar() {
  const items = useNavItems();
  const session = useSession();
  if (items.length === 0 || !session) return null;

  return (
    <aside
      aria-label={`${session.user.role === 'DOCTOR' ? 'Doctor' : 'Patient'} workspace`}
      className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 self-start flex-col bg-sidebar p-3 text-sidebar-foreground lg:flex"
    >
      <p className="px-3 pt-3 pb-2 text-xs font-semibold tracking-widest text-sidebar-foreground/75 uppercase">
        {session.user.role === 'DOCTOR' ? 'Doctor workspace' : 'Patient workspace'}
      </p>
      <nav aria-label="Workspace">
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                  item.active
                    ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                    : 'text-sidebar-foreground/90 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
              >
                <item.icon className="size-4.5 shrink-0" aria-hidden />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-auto rounded-lg bg-sidebar-accent/60 px-3 py-2 text-xs text-sidebar-foreground/90">
        Times are shown in the clinic&apos;s time zone (IST).
      </p>
    </aside>
  );
}
