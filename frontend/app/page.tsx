import { DoctorDirectory } from "./doctor-directory";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-gradient-to-br from-teal-700 to-teal-900 px-6 py-8 text-white sm:px-10 sm:py-10">
        <h1 className="text-2xl font-bold sm:text-3xl">Book an appointment with a doctor</h1>
        <p className="mt-2 max-w-2xl text-sm text-teal-50 sm:text-base">
          Search by doctor or specialty, see real-time availability and confirm your visit in under a minute.
        </p>
      </section>
      <DoctorDirectory />
    </div>
  );
}
