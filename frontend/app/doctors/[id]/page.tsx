import { Suspense } from "react";
import { Spinner } from "@/components/common";
import { BookingFlow } from "./booking-flow";

export default function DoctorBookingPage() {
  // BookingFlow reads the doctor id with useParams, which needs a Suspense boundary
  // because the id is only known at request time.
  return (
    <Suspense fallback={<Spinner label="Loading doctor…" />}>
      <BookingFlow />
    </Suspense>
  );
}
