import { Suspense } from "react";
import { Spinner } from "@/components/common";
import { SignupForm } from "../signup-form";

export const metadata = { title: "Create your account · CareSlot" };

// The original email-code sign-up. It stays reachable while the move to Clerk is checked.
export default function LegacySignupPage() {
  // SignupForm reads ?step= and ?email= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={<Spinner />}>
      <SignupForm />
    </Suspense>
  );
}
