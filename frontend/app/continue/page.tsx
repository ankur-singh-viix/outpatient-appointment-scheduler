import { ContinueRedirect } from "./continue-redirect";

export const metadata = { title: "Signing you in · CareSlot" };

// Where Clerk sends people after signing in or signing up: it looks at where their CareSlot account stands and moves them on.
export default function ContinuePage() {
  return <ContinueRedirect />;
}
