import { Suspense } from "react";
import { Spinner } from "@/components/common";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  // LoginForm reads ?next= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={<Spinner />}>
      <LoginForm />
    </Suspense>
  );
}
