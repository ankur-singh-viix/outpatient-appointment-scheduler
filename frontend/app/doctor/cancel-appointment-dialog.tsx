'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Field, controlClass, fieldProps } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/format';
import type { DoctorAppointment, Session } from '@/lib/types';
import { cn } from '@/lib/utils';
import { fieldErrorsFromApi } from '@/lib/validation';

const MIN_REASON = 3;
const MAX_REASON = 200;

/**
 * Asks the doctor to confirm and to say why before cancelling. The patient reads the reason in their appointment
 * history. Open while `appointment` is set; the server checks the doctor, the time and the status again.
 */
export function CancelAppointmentDialog({
  appointment,
  session,
  onClose,
  onCancelled,
}: {
  appointment: DoctorAppointment | null;
  session: Session;
  onClose: () => void;
  onCancelled: (cancelled: DoctorAppointment) => void;
}) {
  return (
    <Dialog open={appointment !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {/* Keyed by appointment so each one starts with an empty reason and no old error. */}
        {appointment && <CancelForm key={appointment.id} appointment={appointment} session={session} onClose={onClose} onCancelled={onCancelled} />}
      </DialogContent>
    </Dialog>
  );
}

function CancelForm({
  appointment,
  session,
  onClose,
  onCancelled,
}: {
  appointment: DoctorAppointment;
  session: Session;
  onClose: () => void;
  onCancelled: (cancelled: DoctorAppointment) => void;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON) {
      setReasonError(`Please tell the patient why (at least ${MIN_REASON} characters).`);
      return;
    }
    setReasonError(undefined);
    setSubmitting(true);
    try {
      const cancelled = await api<DoctorAppointment>(`/doctor-portal/appointments/${appointment.id}/cancel`, {
        method: 'POST',
        token: session.accessToken,
        body: { reason: trimmed },
      });
      onCancelled(cancelled);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const fromServer = fieldErrorsFromApi(err.details);
        if (fromServer.reason) setReasonError(fromServer.reason);
        else setError(err.message);
      } else {
        setError(errorMessage(err));
      }
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <DialogTitle>Cancel this appointment?</DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">{appointment.patient.name}</span> ·{' '}
          {formatDate(appointment.date, { weekday: 'long' })}, {formatTime(appointment.startTime)}
        </DialogDescription>
        <p className="mt-2 text-sm text-muted-foreground">
          The patient will see your reason in their appointment history, and this time becomes available to others again.
        </p>
      </div>

      {error && <Alert>{error}</Alert>}

      <Field id="cancel-reason" label="Reason for the patient" error={reasonError} hint={`${reason.length}/${MAX_REASON}`}>
        <textarea
          {...fieldProps('cancel-reason', reasonError, 'counter')}
          rows={3}
          maxLength={MAX_REASON}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(undefined);
          }}
          placeholder="For example: I am unwell and cannot see patients today."
          className={cn(controlClass, 'min-h-20 py-2')}
          autoFocus
        />
      </Field>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="lg" className="h-9" onClick={onClose} disabled={submitting}>
          Keep appointment
        </Button>
        <Button
          type="submit"
          size="lg"
          disabled={submitting}
          className="h-9 bg-destructive text-white hover:bg-destructive/90"
        >
          {submitting ? 'Cancelling…' : 'Cancel appointment'}
        </Button>
      </div>
    </form>
  );
}
