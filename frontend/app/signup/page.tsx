import { Suspense } from "react";
import { Spinner } from "@/components/common";
import { SignupForm } from "./signup-form";

export const metadata = { title: "Create your account · CareSlot" };

export default function SignupPage() {
  // SignupForm reads ?step= and ?email= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={<Spinner />}>
      <SignupForm />
    </Suspense>
  );
}
