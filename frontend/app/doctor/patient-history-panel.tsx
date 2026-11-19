'use client';

import { ClipboardListIcon, FileTextIcon, HeartPulseIcon } from 'lucide-react';
import { Alert, EmptyState, Spinner, StatusBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { formatDate, formatTimeRange } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { DoctorPatientClinicalHistory, Session } from '@/lib/types';

const FIELD_LABELS: Record<string, string> = {
  bloodGroup: 'Blood group',
  allergies: 'Allergies',
  sensitivities: 'Sensitivities',
  medicalConditions: 'Existing conditions',
  currentMedications: 'Current medications',
  previousSurgeries: 'Previous surgeries',
  otherMedicalInfo: 'Other medical information',
};

/**
 * Modal clinical history for one patient the doctor is authorized to treat: medical profile, update audit, visits + finalized prescriptions.
 * Does not pause or replace the live queue.
 */
export function PatientHistoryPanel({
  session,
  patientId,
  patientName,
  open,
  onClose,
}: {
  session: Session;
  patientId: string | null;
  patientName?: string;
  open: boolean;
  onClose: () => void;
}) {
  const history = useQuery(open && patientId ? `clinical-history:${session.user.id}:${patientId}` : null, () =>
    api<DoctorPatientClinicalHistory>(`/doctor-portal/patients/${patientId}/clinical-history`, { token: session.accessToken }),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto sm:max-w-3xl">
        <DialogTitle>Patient history</DialogTitle>
        <DialogDescription>
          {patientName ? `Medical profile and visits for ${patientName}.` : 'Medical profile, previous visits and prescriptions.'}
        </DialogDescription>

        {history.loading && !history.data && <Spinner label="Loading patient history…" />}
        {history.error && (
          <Alert
            action={
              <Button size="sm" variant="outline" onClick={history.reload}>
                Try again
              </Button>
            }
          >
            Could not load this patient's history. {history.error}
          </Alert>
        )}

        {history.data && <HistoryBody data={history.data} />}
      </DialogContent>
    </Dialog>
  );
}

function HistoryBody({ data }: { data: DoctorPatientClinicalHistory }) {
  const profile = data.medicalProfile;
  const hasMedical =
    Boolean(profile.bloodGroup?.trim()) ||
    Boolean(profile.allergies?.trim()) ||
    Boolean(profile.sensitivities?.trim()) ||
    Boolean(profile.medicalConditions?.trim()) ||
    Boolean(profile.currentMedications?.trim()) ||
    Boolean(profile.previousSurgeries?.trim()) ||
    Boolean(profile.otherMedicalInfo?.trim());

  return (
    <div className="space-y-8">
      <div className="rounded-xl border bg-muted/30 px-4 py-3">
        <p className="font-semibold text-foreground">{data.patient.name}</p>
        <p className="font-mono text-sm font-semibold tracking-wide text-teal-800 tabular-nums">{data.patient.uhid}</p>
      </div>

      <section aria-labelledby="medical-profile-heading" className="space-y-3">
        <h3 id="medical-profile-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
          <HeartPulseIcon className="size-4" aria-hidden />
          Medical profile
        </h3>
        {!hasMedical ? (
          <EmptyState title="No medical information on file" icon={HeartPulseIcon}>
            <p>The patient has not added medical details yet.</p>
          </EmptyState>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Field label="Blood group">{profile.bloodGroup}</Field>
            <Field label="Allergies">{profile.allergies}</Field>
            <Field label="Sensitivities">{profile.sensitivities}</Field>
            <Field label="Existing conditions">{profile.medicalConditions}</Field>
            <Field label="Current medications">{profile.currentMedications}</Field>
            <Field label="Previous surgeries">{profile.previousSurgeries}</Field>
            <div className="sm:col-span-2">
              <Field label="Other medical information">{profile.otherMedicalInfo}</Field>
            </div>
          </dl>
        )}

        {data.medicalUpdates.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium text-foreground">Recent profile updates</p>
            <ul className="space-y-2">
              {data.medicalUpdates.map((row) => (
                <li key={row.id} className="rounded-lg border px-3 py-2 text-sm">
                  <p className="font-medium text-foreground">{FIELD_LABELS[row.fieldName] ?? row.fieldName}</p>
                  <p className="text-muted-foreground">
                    {displayValue(row.previousValue)} → {displayValue(row.newValue)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDate(row.updatedAt.slice(0, 10), { weekday: undefined })} · {row.updatedBy.name}
                    {row.updatedBy.role ? ` (${row.updatedBy.role})` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="visits-heading" className="space-y-3">
        <h3 id="visits-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
          <ClipboardListIcon className="size-4" aria-hidden />
          Previous visits
        </h3>
        {data.visits.length === 0 ? (
          <EmptyState title="No previous visits" icon={ClipboardListIcon}>
            <p>Appointments with you for this patient will appear here.</p>
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {data.visits.map((visit) => (
              <li key={visit.appointmentId} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-foreground">
                      {formatDate(visit.date, { weekday: 'long' })} · {formatTimeRange(visit.startTime, visit.endTime)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {visit.doctor.name}
                      {visit.queueToken != null ? ` · Token ${visit.queueToken}` : ''}
                      {` · UHID ${data.patient.uhid}`}
                    </p>
                  </div>
                  <StatusBadge status={visit.status} />
                </div>

                <div className="mt-3 border-t pt-3">
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <FileTextIcon className="size-3.5" aria-hidden />
                    Prescription
                  </p>
                  {!visit.prescription ? (
                    <p className="text-sm text-muted-foreground">No finalized prescription for this visit.</p>
                  ) : (
                    <div className="space-y-2 text-sm">
                      {visit.prescription.diagnosis && (
                        <p>
                          <span className="font-medium text-foreground">Diagnosis: </span>
                          {visit.prescription.diagnosis}
                        </p>
                      )}
                      {visit.prescription.notes && (
                        <p>
                          <span className="font-medium text-foreground">Notes: </span>
                          {visit.prescription.notes}
                        </p>
                      )}
                      {!visit.prescription.diagnosis && !visit.prescription.notes && (
                        <p className="text-muted-foreground">No diagnosis or consultation notes recorded.</p>
                      )}
                      {visit.prescription.medications.length > 0 && (
                        <ul className="list-disc space-y-1 pl-5">
                          {visit.prescription.medications.map((med, index) => (
                            <li key={`${med.name}-${index}`}>
                              {med.name}
                              {[med.dosage, med.frequency, med.duration].filter(Boolean).length > 0 && (
                                <> — {[med.dosage, med.frequency, med.duration].filter(Boolean).join(', ')}</>
                              )}
                              {med.instructions ? ` (${med.instructions})` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{children?.trim() ? children : <span className="text-muted-foreground">Not provided</span>}</dd>
    </div>
  );
}

function displayValue(value: string | null) {
  return value?.trim() ? value : '—';
}
