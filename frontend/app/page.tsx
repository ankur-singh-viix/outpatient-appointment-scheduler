import { CalendarCheckIcon, ClockIcon, ShieldCheckIcon } from "lucide-react";
import { DoctorDirectory } from "./doctor-directory";

const HIGHLIGHTS = [
  { icon: ClockIcon, title: "Live availability", text: "Open slots update the moment someone books." },
  { icon: ShieldCheckIcon, title: "No double bookings", text: "A slot or session that is full cannot be booked." },
  { icon: CalendarCheckIcon, title: "Instant confirmation", text: "Pick a time and confirm in under a minute." },
];

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-teal-700 via-teal-800 to-teal-950 px-6 pt-8 pb-20 text-white shadow-sm animate-in fade-in-0 slide-in-from-bottom-2 duration-500 sm:px-10 sm:pt-12 sm:pb-28">
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          Book an appointment with the right doctor
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-teal-50 sm:text-base">
          Search by doctor or specialty, see real-time availability and confirm your visit in under a minute.
        </p>
        <ul className="mt-6 hidden gap-3 sm:grid sm:grid-cols-3">
          {HIGHLIGHTS.map((item) => (
            <li key={item.title} className="flex items-start gap-3 rounded-xl bg-white/10 p-3 ring-1 ring-white/15">
              <item.icon className="mt-0.5 size-5 shrink-0 text-teal-200" aria-hidden />
              <div>
                <p className="text-sm font-semibold">{item.title}</p>
                <p className="text-xs text-teal-100">{item.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {/* The search card floats over the bottom edge of the hero so it is the first thing to use. */}
      <div className="relative -mt-24 sm:-mt-32">
        <DoctorDirectory />
      </div>
    </div>
  );
}
