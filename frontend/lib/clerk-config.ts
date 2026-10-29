/**
 * True when a Clerk publishable key is configured (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY). Without one the app does not load
 * Clerk at all and works exactly as before, with the legacy login only. Inlined at build time, like the other
 * NEXT_PUBLIC_ values.
 */
export const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
