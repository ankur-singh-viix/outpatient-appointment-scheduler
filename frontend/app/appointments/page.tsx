import { MyAppointments } from "./my-appointments";

export default function AppointmentsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">My appointments</h1>
      <MyAppointments />
    </div>
  );
}
