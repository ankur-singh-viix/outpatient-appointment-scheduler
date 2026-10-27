'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/button';
import { saveSession, useHydrated, useSession } from '@/lib/session';

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 text-lg font-bold text-foreground">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm text-primary-foreground" aria-hidden>
        +
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
    { href: '/', label: 'Find doctors', show: role !== 'DOCTOR' },
    { href: '/appointments', label: 'My appointments', show: role === 'PATIENT' },
    { href: '/doctor', label: 'Dashboard', show: role === 'DOCTOR' },
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
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={buttonVariants({ variant: pathname === link.href ? 'secondary' : 'ghost' })}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Rendered only after hydration so the server and browser markup match. */}
        <div className="flex min-h-9 items-center gap-3 text-sm">
          {hydrated && session && (
            <>
              <span className="hidden text-muted-foreground sm:inline">
                {session.user.name} <span className="opacity-70">· {session.user.role.toLowerCase()}</span>
              </span>
              <Button variant="ghost" onClick={signOut}>
                Sign out
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
