import { PageHeader } from "@/components/common";
import { PaymentsView } from "./payments-view";

export const metadata = { title: "Payments & Receipts · CareSlot" };

export default function PaymentsPage() {
  return (
    <div className="animate-in fade-in-0 duration-300">
      <PageHeader title="Payments & Receipts" description="What you have paid, your receipts, and the status of any refund." />
      <PaymentsView />
    </div>
  );
}
