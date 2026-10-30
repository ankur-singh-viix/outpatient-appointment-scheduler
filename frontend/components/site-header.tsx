'use client';

import { LogOutIcon, SearchIcon, StethoscopeIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Avatar } from '@/components/common';
import { useNavItems } from '@/components/nav';
import { Button, buttonVariants } from '@/components/ui/button';
import { initials } from '@/lib/format';
import { signOutEverywhere, useAuthState, useHydrated, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

function Brand({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 text-lg font-bold tracking-tight text-foreground">
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
    <header className="sticky top-0 z-30 border-b bg-card/95">
      <div className="mx-auto flex h-14 max-w-6xl items-center px-4">
        <Brand />
      </div>
    </header>
  );
}

/** A compact top bar: logo, who is signed in, sign out. The workspace navigation lives in the sidebar. */
export function SiteHeader() {
  const session = useSession();
  const hydrated = useHydrated();
  const pathname = usePathname();
  const router = useRouter();
  const items = useNavItems();

  const authState = useAuthState();
  const needsSetup = authState === 'needs-profile' || authState === 'needs-link' || authState === 'blocked';

  const signOut = async () => {
    await signOutEverywhere();
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
      <div className="flex h-14 items-center justify-between gap-4 px-4 lg:px-6">
        {/* A signed-in patient's home is their dashboard (it is not in the sidebar); everyone else's is the doctor list. */}
        <Brand href={hydrated && session?.user.role === 'PATIENT' ? '/dashboard' : '/'} />

        {/* Rendered only after hydration so the server and browser markup match. */}
        <div className="flex items-center gap-2 text-sm">
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
          {hydrated && !session && needsSetup && (
            <>
              <Link href="/onboarding" className={buttonVariants({ size: 'lg' })}>
                Finish setup
              </Link>
              <Button variant="ghost" size="lg" onClick={signOut} className="gap-2" aria-label="Sign out">
                <LogOutIcon aria-hidden />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          )}
          {/* Only once we know nobody is signed in: while Clerk is still loading, show nothing rather than flash these. */}
          {hydrated && !session && authState === 'signed-out' && (
            <>
              {pathname !== '/' && (
                <Link href="/" className={cn(buttonVariants({ variant: 'ghost', size: 'lg' }), 'gap-2')}>
                  <SearchIcon aria-hidden />
                  <span className="hidden sm:inline">Find doctors</span>
                </Link>
              )}
              {pathname !== '/login' && (
                <Link href="/login" className={buttonVariants({ variant: 'ghost', size: 'lg' })}>
                  Sign in
                </Link>
              )}
              {pathname !== '/signup' && pathname !== '/onboarding' && (
                <Link href="/signup" className={buttonVariants({ size: 'lg' })}>
                  Get started
                </Link>
              )}
            </>
          )}
        </div>
      </div>

      {/* On phones the sidebar is replaced by this strip. */}
      {items.length > 0 && (
        <nav aria-label="Workspace (mobile)" className="flex gap-1 overflow-x-auto border-t px-3 py-1.5 lg:hidden">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={cn(
                buttonVariants({ variant: item.active ? 'default' : 'ghost', size: 'lg' }),
                'shrink-0 gap-2',
              )}
            >
              <item.icon aria-hidden />
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
