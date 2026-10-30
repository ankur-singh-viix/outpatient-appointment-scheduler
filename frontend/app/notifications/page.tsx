import { PageHeader } from "@/components/common";
import { NotificationsView } from "./notifications-view";

export const metadata = { title: "Notifications · CareSlot" };

export default function NotificationsPage() {
  return (
    <div className="animate-in fade-in-0 duration-300">
      <PageHeader title="Notifications" description="Confirmations, payment and refund updates, and reminders for your appointments." />
      <NotificationsView />
    </div>
  );
}
