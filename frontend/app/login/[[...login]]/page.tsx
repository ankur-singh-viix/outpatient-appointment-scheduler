import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";
import { Spinner } from "@/components/common";
import { CLERK_ENABLED } from "@/lib/clerk-config";
import { LoginForm } from "../login-form";

export const metadata = { title: "Sign in · CareSlot" };

export default function LoginPage() {
  // LoginForm reads ?next= with useSearchParams, which needs a Suspense boundary.
  const legacyLogin = (
    <Suspense fallback={<Spinner />}>
      <LoginForm />
    </Suspense>
  );

  // Without a Clerk key this is exactly the login the app has always had.
  if (!CLERK_ENABLED) return legacyLogin;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex justify-center">
        {/* Clerk's prebuilt form on a catch-all route needs its own Suspense boundary (Cache Components). */}
        <Suspense fallback={<Spinner />}>
          <SignIn routing="path" path="/login" signUpUrl="/signup" fallbackRedirectUrl="/continue" />
        </Suspense>
      </div>
      {/* The existing login stays available while the move to Clerk is checked. */}
      <details className="rounded-xl border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          Sign in with a CareSlot account instead (demo and existing logins)
        </summary>
        <div className="mt-4">{legacyLogin}</div>
      </details>
    </div>
  );
}
