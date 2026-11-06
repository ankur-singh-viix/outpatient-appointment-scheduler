import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Next.js 16 calls this file "proxy" (it used to be "middleware"). With a Clerk key it lets Clerk keep the session in
// step; without one it does nothing, so the app works exactly as before. No route is blocked here: pages decide what to
// show (RequireRole) and the API decides what to allow (AuthGuard and the role checks), so the legacy login is unaffected.
export default process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // Skip Next.js internals and static files, as Clerk's setup guide does.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
};
