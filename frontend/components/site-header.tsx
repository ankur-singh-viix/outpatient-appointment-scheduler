'use client';

import { CalendarCheckIcon, LayoutDashboardIcon, LogOutIcon, SearchIcon, StethoscopeIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Avatar } from '@/components/common';
import { Button, buttonVariants } from '@/components/ui/button';
import { initials } from '@/lib/format';
import { saveSession, useHydrated, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight text-foreground">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden>
        <StethoscopeIcon className="size-4.5" />
      </span>
      CareSlot
    </Link>
  );
}

/** Static header shown while the interactive one loads. */
export function SiteHeaderFallback() {
  return (
    <header className="sticky top-0 z-20 border-b bg-card/95">
      <div className="mx-auto flex min-h-15 max-w-6xl items-center px-4 py-3">
        <Brand />
      </div>
    </header>
  );
}

export function SiteHeader() {
  const session = useSession();
  const hydrated = useHydrated();
  const pathname = usePathname();
  const router = useRouter();
  const role = session?.user.role;

  const links = [
    { href: '/', label: 'Find doctors', icon: SearchIcon, show: role !== 'DOCTOR' },
    { href: '/appointments', label: 'My appointments', icon: CalendarCheckIcon, show: role === 'PATIENT' },
    { href: '/doctor', label: 'Dashboard', icon: LayoutDashboardIcon, show: role === 'DOCTOR' },
  ].filter((link) => link.show);

  const signOut = () => {
    saveSession(null);
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Brand />

        <nav className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto" aria-label="Main">
          {links.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(buttonVariants({ variant: active ? 'secondary' : 'ghost', size: 'lg' }), 'gap-2', active && 'text-primary')}
              >
                <link.icon aria-hidden />
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* Rendered only after hydration so the server and browser markup match. */}
        <div className="flex min-h-9 items-center gap-2 text-sm">
          {hydrated && session && (
            <>
              <div className="flex items-center gap-2">
                <Avatar size="sm" text={initials(session.user.name)} />
                <div className="hidden leading-tight sm:block">
                  <p className="font-medium text-foreground">{session.user.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{session.user.role.toLowerCase()}</p>
                </div>
              </div>
              <Button variant="ghost" size="lg" onClick={signOut} className="gap-2" aria-label="Sign out">
                <LogOutIcon aria-hidden />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          )}
          {hydrated && !session && pathname !== '/login' && (
            <Link href="/login" className={buttonVariants({ size: 'lg' })}>
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
