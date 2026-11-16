'use client';

import { ClipboardPlusIcon, PlusIcon } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Alert, EmptyState, PageHeader, Spinner } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { RequireRole } from '@/components/require-role';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatTimeRange } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { DoctorAppointment, PrescriptionDetail, PrescriptionMedication, PrescriptionSummary, Session } from '@/lib/types';

export function DoctorPrescriptionsPage() {
  return (
    <RequireRole role="DOCTOR" nextPath="/doctor/prescriptions">
      {(session) => <Prescriptions session={session} />}
    </RequireRole>
  );
}

function Prescriptions({ session }: { session: Session }) {
  const list = useQuery(`doctor-prescriptions:${session.user.id}`, () =>
    api<PrescriptionSummary[]>('/prescriptions/doctor', { token: session.accessToken }),
  );
  const appointments = useQuery(`doctor-rx-appts:${session.user.id}`, () =>
    api<DoctorAppointment[]>('/doctor-portal/appointments?scope=all', { token: session.accessToken }),
  );
  const [editing, setEditing] = useState<PrescriptionDetail | 'new' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const rows = list.data ?? list.previous ?? [];
  const completed = useMemo(() => {
    const taken = new Set(rows.map((row) => row.appointmentId));
    return (appointments.data ?? appointments.previous ?? []).filter((row) => row.status === 'COMPLETED' && !taken.has(row.id));
  }, [appointments.data, appointments.previous, rows]);

  const reload = () => {
    list.reload();
    appointments.reload();
  };

  return (
    <div className="animate-in fade-in-0 space-y-6 duration-300">
      <PageHeader title="Prescriptions" description="Draft and finalize prescriptions for completed consultations." />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {(list.loading && !list.data && !list.previous) || (appointments.loading && !appointments.data && !appointments.previous) ? (
        <Spinner label="Loading prescriptions…" />
      ) : null}
      {(list.error || appointments.error) && <Alert>{list.error ?? appointments.error}</Alert>}

      {editing === 'new' && (
        <Editor
          session={session}
          appointments={completed}
          onCancel={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice({ tone: 'success', text: message });
            reload();
          }}
          onError={(text) => setNotice({ tone: 'error', text })}
        />
      )}
      {editing && editing !== 'new' && (
        <Editor
          session={session}
          existing={editing}
          appointments={[]}
          onCancel={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice({ tone: 'success', text: message });
            reload();
          }}
          onError={(text) => setNotice({ tone: 'error', text })}
        />
      )}

      {!editing && (
        <>
          <div className="flex justify-end">
            <Button disabled={completed.length === 0} onClick={() => setEditing('new')}>
              <PlusIcon aria-hidden /> New prescription
            </Button>
          </div>
          {rows.length === 0 ? (
            <EmptyState title="No prescriptions yet" icon={ClipboardPlusIcon}>
              <p>After you complete a consultation, you can draft and finalize a prescription here.</p>
            </EmptyState>
          ) : (
            <ul className="divide-y rounded-xl border bg-card" aria-label="Prescriptions">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">
                      {row.patient.name}{' '}
                      <Badge variant="secondary">{row.status === 'FINALIZED' ? 'Finalized' : 'Draft'}</Badge>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {formatDate(row.appointment.date)} · {formatTimeRange(row.appointment.startTime, row.appointment.endTime)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void api<PrescriptionDetail>(`/prescriptions/doctor/${row.id}`, { token: session.accessToken })
                        .then(setEditing)
                        .catch((error) => setNotice({ tone: 'error', text: errorMessage(error) }))
                    }
                  >
                    {row.status === 'DRAFT' ? 'Edit' : 'View'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function emptyMed(): PrescriptionMedication {
  return { name: '', dosage: '', frequency: '', duration: '', instructions: '' };
}

function Editor({
  session,
  existing,
  appointments,
  onCancel,
  onSaved,
  onError,
}: {
  session: Session;
  existing?: PrescriptionDetail;
  appointments: DoctorAppointment[];
  onCancel: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const locked = existing?.status === 'FINALIZED';
  const [appointmentId, setAppointmentId] = useState(existing?.appointmentId ?? appointments[0]?.id ?? '');
  const [diagnosis, setDiagnosis] = useState(existing?.diagnosis ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [medications, setMedications] = useState<PrescriptionMedication[]>(existing?.medications?.length ? existing.medications : [emptyMed()]);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent, finalize = false) => {
    event.preventDefault();
    if (busy || locked) return;
    setBusy(true);
    try {
      const body = {
        diagnosis: diagnosis.trim() || null,
        notes: notes.trim() || null,
        medications: medications
          .map((med) => ({
            name: med.name.trim(),
            dosage: med.dosage?.trim() || undefined,
            frequency: med.frequency?.trim() || undefined,
            duration: med.duration?.trim() || undefined,
            instructions: med.instructions?.trim() || undefined,
          }))
          .filter((med) => med.name),
      };
      let id = existing?.id;
      if (existing) {
        await api(`/prescriptions/doctor/${existing.id}`, { method: 'PUT', token: session.accessToken, body });
      } else {
        const created = await api<PrescriptionDetail>('/prescriptions/doctor', {
          method: 'POST',
          token: session.accessToken,
          body: { ...body, appointmentId },
        });
        id = created.id;
      }
      if (finalize && id) {
        await api(`/prescriptions/doctor/${id}/finalize`, { method: 'POST', token: session.accessToken, body: {} });
        onSaved('Prescription finalized.');
      } else {
        onSaved(existing ? 'Draft saved.' : 'Draft created.');
      }
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-4 rounded-xl border bg-card p-5" onSubmit={(event) => void save(event, false)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{locked ? 'Finalized prescription' : existing ? 'Edit draft' : 'New prescription'}</h2>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Close
        </Button>
      </div>

      {!existing && (
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Completed appointment</span>
          <select className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm" value={appointmentId} onChange={(e) => setAppointmentId(e.target.value)} required disabled={busy}>
            <option value="">Select…</option>
            {appointments.map((row) => (
              <option key={row.id} value={row.id}>
                {row.patient.name} · {formatDate(row.date)} · {formatTimeRange(row.startTime, row.endTime)}
              </option>
            ))}
          </select>
        </label>
      )}

      {existing && (
        <p className="text-sm text-muted-foreground">
          {existing.patient.name} · {formatDate(existing.appointment.date)} · {formatTimeRange(existing.appointment.startTime, existing.appointment.endTime)}
        </p>
      )}

      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">Diagnosis</span>
        <Input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} disabled={locked || busy} maxLength={500} />
      </label>

      <fieldset className="space-y-3" disabled={locked || busy}>
        <legend className="text-sm font-medium">Medications</legend>
        {medications.map((med, index) => (
          <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
            <Input placeholder="Name" value={med.name} onChange={(e) => setMedications((rows) => rows.map((row, i) => (i === index ? { ...row, name: e.target.value } : row)))} required />
            <Input placeholder="Dosage" value={med.dosage ?? ''} onChange={(e) => setMedications((rows) => rows.map((row, i) => (i === index ? { ...row, dosage: e.target.value } : row)))} />
            <Input placeholder="Frequency" value={med.frequency ?? ''} onChange={(e) => setMedications((rows) => rows.map((row, i) => (i === index ? { ...row, frequency: e.target.value } : row)))} />
            <Input placeholder="Duration" value={med.duration ?? ''} onChange={(e) => setMedications((rows) => rows.map((row, i) => (i === index ? { ...row, duration: e.target.value } : row)))} />
            <Input className="sm:col-span-2" placeholder="Instructions" value={med.instructions ?? ''} onChange={(e) => setMedications((rows) => rows.map((row, i) => (i === index ? { ...row, instructions: e.target.value } : row)))} />
            {!locked && medications.length > 1 && (
              <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => setMedications((rows) => rows.filter((_, i) => i !== index))}>
                Remove
              </Button>
            )}
          </div>
        ))}
        {!locked && (
          <Button type="button" variant="outline" size="sm" onClick={() => setMedications((rows) => [...rows, emptyMed()])}>
            Add medication
          </Button>
        )}
      </fieldset>

      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">Notes</span>
        <textarea className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked || busy} maxLength={2000} />
      </label>

      {!locked && (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            Save draft
          </Button>
          <Button type="button" disabled={busy} onClick={(event) => void save(event, true)}>
            Save and finalize
          </Button>
        </div>
      )}
    </form>
  );
}
