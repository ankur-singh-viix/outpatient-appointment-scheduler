import { PageHeader } from "@/components/common";
import { ProfileView } from "./profile-view";

export const metadata = { title: "My Profile · CareSlot" };

export default function ProfilePage() {
  return (
    <div className="animate-in fade-in-0 duration-300">
      <PageHeader title="My Profile" description="Your account and contact details." />
      <ProfileView />
    </div>
  );
}
