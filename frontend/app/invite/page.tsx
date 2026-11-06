import { Suspense } from "react";
import { Spinner } from "@/components/common";
import { InviteForm } from "./invite-form";

// The link holds a one-time token, so do not pass it on to other sites in the Referer header.
export const metadata = { title: "Set your password · CareSlot", referrer: "no-referrer" as const };

export default function InvitePage() {
  // InviteForm reads ?token= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={<Spinner />}>
      <InviteForm />
    </Suspense>
  );
}
