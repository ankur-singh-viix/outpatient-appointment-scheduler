import { PageHeader } from "@/components/common";
import { MyAppointments } from "./my-appointments";

export default function AppointmentsPage() {
  return (
    <div className="animate-in fade-in-0 duration-300">
      <PageHeader title="My appointments" description="Your upcoming visits and booking history." />
      <MyAppointments />
    </div>
  );
}
