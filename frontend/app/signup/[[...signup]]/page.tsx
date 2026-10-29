import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { Suspense } from "react";
import { Spinner } from "@/components/common";
import { CLERK_ENABLED } from "@/lib/clerk-config";
import { SignupForm } from "../signup-form";

export const metadata = { title: "Create your account · CareSlot" };

export default function SignupPage() {
  // Without a Clerk key this is exactly the email-code sign-up the app has had.
  if (!CLERK_ENABLED) {
    return (
      <Suspense fallback={<Spinner />}>
        <SignupForm />
      </Suspense>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex justify-center">
        {/* Clerk's prebuilt form on a catch-all route needs its own Suspense boundary (Cache Components). */}
        <Suspense fallback={<Spinner />}>
          <SignUp routing="path" path="/signup" signInUrl="/login" fallbackRedirectUrl="/continue" />
        </Suspense>
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Prefer the CareSlot email code?{" "}
        <Link href="/signup/legacy" className="font-medium text-primary hover:underline">
          Use email-code sign-up
        </Link>
      </p>
    </div>
  );
}
