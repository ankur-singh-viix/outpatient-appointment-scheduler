'use client';

import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Field, controlClass, fieldProps } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import type { BloodGroup, PatientProfile, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

const BLOOD_GROUPS: BloodGroup[] = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

type MedicalForm = {
  bloodGroup: string;
  allergies: string;
  sensitivities: string;
  medicalConditions: string;
  currentMedications: string;
  previousSurgeries: string;
  otherMedicalInfo: string;
};

function fromProfile(p: PatientProfile): MedicalForm {
  return {
    bloodGroup: p.bloodGroup ?? '',
    allergies: p.allergies ?? '',
    sensitivities: p.sensitivities ?? '',
    medicalConditions: p.medicalConditions ?? '',
    currentMedications: p.currentMedications ?? '',
    previousSurgeries: p.previousSurgeries ?? '',
    otherMedicalInfo: p.otherMedicalInfo ?? '',
  };
}

function toPayload(form: MedicalForm) {
  const text = (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };
  return {
    bloodGroup: (form.bloodGroup || null) as BloodGroup | null,
    allergies: text(form.allergies),
    sensitivities: text(form.sensitivities),
    medicalConditions: text(form.medicalConditions),
    currentMedications: text(form.currentMedications),
    previousSurgeries: text(form.previousSurgeries),
    otherMedicalInfo: text(form.otherMedicalInfo),
  };
}

export function MedicalProfileForm({
  session,
  profile,
  onSaved,
}: {
  session: Session;
  profile: PatientProfile;
  onSaved: (next: PatientProfile) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<MedicalForm>(() => fromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (field: keyof MedicalForm) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError(null);
  };

  const startEdit = () => {
    setForm(fromProfile(profile));
    setEditing(true);
    setError(null);
    setNotice(null);
  };

  const cancel = () => {
    setForm(fromProfile(profile));
    setEditing(false);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api<PatientProfile>('/auth/me/profile/medical', {
        method: 'PUT',
        token: session.accessToken,
        body: toPayload(form),
      });
      onSaved(next);
      setForm(fromProfile(next));
      setEditing(false);
      setNotice('Medical information saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}

      {!editing ? (
        <>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <ReadField label="Blood group">{profile.bloodGroup}</ReadField>
            <ReadField label="Allergies">{profile.allergies}</ReadField>
            <ReadField label="Sensitivities">{profile.sensitivities}</ReadField>
            <ReadField label="Existing conditions">{profile.medicalConditions}</ReadField>
            <ReadField label="Current medications">{profile.currentMedications}</ReadField>
            <ReadField label="Previous surgeries">{profile.previousSurgeries}</ReadField>
            <div className="sm:col-span-2">
              <ReadField label="Other medical information">{profile.otherMedicalInfo}</ReadField>
            </div>
          </dl>
          <Button type="button" variant="outline" size="lg" className="h-9" onClick={startEdit}>
            Edit medical information
          </Button>
        </>
      ) : (
        <form onSubmit={save} className="space-y-4" noValidate>
          <Field id="blood-group" label="Blood group" optional>
            <select
              {...fieldProps('blood-group')}
              value={form.bloodGroup}
              onChange={(e) => set('bloodGroup')(e.target.value)}
              className={cn(controlClass, 'h-10')}
            >
              <option value="">Not provided</option>
              {BLOOD_GROUPS.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </Field>
          <TextAreaField id="allergies" label="Allergies" value={form.allergies} onChange={set('allergies')} />
          <TextAreaField id="sensitivities" label="Sensitivities" value={form.sensitivities} onChange={set('sensitivities')} />
          <TextAreaField
            id="medical-conditions"
            label="Existing medical conditions"
            value={form.medicalConditions}
            onChange={set('medicalConditions')}
          />
          <TextAreaField
            id="current-medications"
            label="Current medications"
            value={form.currentMedications}
            onChange={set('currentMedications')}
          />
          <TextAreaField
            id="previous-surgeries"
            label="Previous surgeries"
            value={form.previousSurgeries}
            onChange={set('previousSurgeries')}
          />
          <TextAreaField
            id="other-medical-info"
            label="Other medical information"
            value={form.otherMedicalInfo}
            onChange={set('otherMedicalInfo')}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="lg" className="h-9" disabled={saving}>
              {saving ? 'Saving…' : 'Save medical information'}
            </Button>
            <Button type="button" variant="outline" size="lg" className="h-9" disabled={saving} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReadField({ label, children }: { label: string; children: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words text-foreground">
        {children?.trim() ? children : <span className="font-normal text-muted-foreground">Not provided</span>}
      </dd>
    </div>
  );
}

function TextAreaField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} optional>
      <textarea
        {...fieldProps(id)}
        rows={3}
        maxLength={2000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(controlClass, 'min-h-20 py-2')}
      />
    </Field>
  );
}
