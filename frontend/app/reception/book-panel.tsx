'use client';

import { StethoscopeIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatFee, formatTime, formatTimeRange } from '@/lib/format';
import { useClinicToday } from '@/lib/hooks';
import type { ReceptionDoctor, ReceptionPatient, Session, Slot } from '@/lib/types';
import { ChoiceCards } from '../doctor/choice-cards';
import { PatientSearch } from './patient-search';
import { SlotPicker } from './slot-picker';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{children}</dd>
    </div>
  );
}

/**
 * Books a registered patient into an open slot of one of the clinic's doctors: pick the doctor, the date and slot, then the
 * patient. The server decides whether the slot can still be booked (Stream: one patient; Wave: until its places run out), so two
 * people at the desk, or a patient online, can never overbook it; a refused booking just refreshes the slots.
 */
export function BookPanel({ session, doctors, onBooked }: { session: Session; doctors: ReceptionDoctor[]; onBooked: (message: string) => void }) {
  const today = useClinicToday();
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? '');
  const [pickedDate, setPickedDate] = useState('');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [patient, setPatient] = useState<ReceptionPatient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const doctor = doctors.find((entry) => entry.id === doctorId) ?? doctors[0];
  const date = pickedDate || today || '';
  const places = slot && (slot.capacityPerSlot ?? 1) > 1 ? `${slot.remaining ?? 0} of ${slot.capacityPerSlot} places left` : null;

  const book = async () => {
    if (!slot || !patient || !doctor) return;
    setBusy(true);
    setError(null);
    try {
      await api('/receptionist/appointments', {
        method: 'POST',
        token: session.accessToken,
        body: { patientId: patient.id, doctorId: doctor.id, date, startTime: slot.startTime, ...(slot.availabilityId ? { availabilityId: slot.availabilityId } : {}) },
      });
      onBooked(`Booked ${patient.name} with ${doctor.name} on ${formatDate(date, { weekday: 'long' })} at ${formatTime(slot.startTime)}. The fee is paid at the clinic.`);
      setSlot(null);
      setPatient(null);
    } catch (err) {
      setError(errorMessage(err));
      setSlot(null); // the slot may have just been taken: choose again from fresh availability
    } finally {
      setVersion((current) => current + 1);
      setBusy(false);
    }
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card className="[--card-spacing:--spacing(6)]">
          <CardHeader>
            <CardTitle as="h2" className="text-lg font-semibold">
              1. Choose a doctor
            </CardTitle>
            <CardDescription>The doctors at your clinic.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChoiceCards
              legend="Doctor"
              name="reception-doctor"
              value={doctor?.id ?? ''}
              onChange={(id) => {
                setDoctorId(id);
                setSlot(null);
              }}
              choices={doctors.map((entry) => ({
                value: entry.id,
                title: entry.name,
                description: `${entry.specialty} · ${formatFee(entry.consultationFee)} · ${entry.clinic.name}`,
                icon: StethoscopeIcon,
              }))}
            />
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(6)]">
          <CardHeader>
            <CardTitle as="h2" className="text-lg font-semibold">
              2. Pick a date and slot
            </CardTitle>
            <CardDescription>Availability is live: a place taken by someone else shows up within seconds.</CardDescription>
          </CardHeader>
          <CardContent>
            {doctor && <SlotPicker key={doctor.id} doctor={doctor} date={date} onDateChange={setPickedDate} selected={slot} onSelect={setSlot} version={version} />}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6 xl:sticky xl:top-20">
        <Card className="[--card-spacing:--spacing(6)]">
          <CardHeader>
            <CardTitle as="h2" className="text-lg font-semibold">
              3. Patient
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PatientSearch session={session} selected={patient} onSelect={setPatient} />
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(6)]">
          <CardHeader>
            <CardTitle as="h2" className="text-lg font-semibold">
              Review &amp; book
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert>{error}</Alert>}
            {slot && doctor ? (
              <dl className="divide-y rounded-xl bg-muted/60 px-4">
                <Row label="Doctor">{doctor.name}</Row>
                <Row label="Date">{formatDate(date, { weekday: 'long' })}</Row>
                <Row label="Time">{formatTimeRange(slot.startTime, slot.endTime)}</Row>
                {places && <Row label="Shared slot">{places}</Row>}
                <Row label="Patient">{patient ? patient.name : <span className="text-muted-foreground">Not chosen yet</span>}</Row>
                <Row label="Fee">{formatFee(doctor.consultationFee)} · paid at the clinic</Row>
              </dl>
            ) : (
              <p className="rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">Choose an open slot to see the booking here.</p>
            )}
            <Button type="button" size="lg" className="h-10 w-full" disabled={!slot || !patient || busy} onClick={() => void book()}>
              {busy ? 'Booking…' : !slot ? 'Select a slot' : !patient ? 'Choose a patient' : 'Book appointment'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
