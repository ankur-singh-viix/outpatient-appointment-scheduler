'use client';

import { FileUpIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiForm, errorMessage } from '@/lib/api';
import type { MedicalReport, MedicalReportCategory, ReceptionPatient, Session } from '@/lib/types';
import { MEDICAL_REPORT_CATEGORY_LABELS } from '@/lib/types';
import { PatientSearch } from './patient-search';

const CATEGORIES = Object.keys(MEDICAL_REPORT_CATEGORY_LABELS) as MedicalReportCategory[];

/**
 * Front-desk upload only: choose a registered patient (existing search), then upload a report.
 * Does not list or download patient report libraries.
 */
export function ReportsPanel({ session }: { session: Session }) {
  const [patient, setPatient] = useState<ReceptionPatient | null>(null);
  const [category, setCategory] = useState<MedicalReportCategory>('OTHER');
  const [reportDate, setReportDate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!patient || !file || !reportDate) {
      setFeedback({ tone: 'error', message: 'Select a patient, report date and file.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const form = new FormData();
      form.set('patientId', patient.id);
      form.set('category', category);
      form.set('reportDate', reportDate);
      form.set('file', file);
      const created = await apiForm<MedicalReport>('/medical-reports/reception', form, session.accessToken);
      setFile(null);
      setFeedback({
        tone: 'success',
        message: `Uploaded ${created.originalFilename} for ${patient.name}. Doctors assigned to you can view it in the patient history.`,
      });
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardContent className="space-y-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">Upload a medical report</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The patient must already have an appointment with a doctor who assigned you. You can upload documents; you cannot browse or download a patient&apos;s full report library.
          </p>
        </div>

        <PatientSearch session={session} selected={patient} onSelect={setPatient} />

        <form className="grid gap-3 sm:grid-cols-2" onSubmit={upload}>
          <div className="space-y-2">
            <Label htmlFor="reception-report-category">Category</Label>
            <select
              id="reception-report-category"
              className="flex h-10 w-full rounded-lg border border-input bg-card px-3 text-sm"
              value={category}
              onChange={(event) => setCategory(event.target.value as MedicalReportCategory)}
            >
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {MEDICAL_REPORT_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reception-report-date">Report date</Label>
            <Input id="reception-report-date" type="date" required value={reportDate} onChange={(event) => setReportDate(event.target.value)} className="h-10 bg-card" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="reception-report-file">File (PDF, JPG or PNG, max 10 MB)</Label>
            <Input
              id="reception-report-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="h-10 bg-card"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" size="lg" className="h-10 gap-2" disabled={busy || !patient}>
              <FileUpIcon aria-hidden />
              {busy ? 'Uploading…' : 'Upload for patient'}
            </Button>
          </div>
        </form>

        {feedback && <Alert tone={feedback.tone === 'success' ? 'success' : 'error'}>{feedback.message}</Alert>}
      </CardContent>
    </Card>
  );
}
