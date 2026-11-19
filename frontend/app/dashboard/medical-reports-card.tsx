'use client';

import { FileUpIcon, FolderOpenIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, apiForm, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import type { MedicalReport, MedicalReportCategory, MedicalReportDownload, Session } from '@/lib/types';
import { MEDICAL_REPORT_CATEGORY_LABELS } from '@/lib/types';

const CATEGORIES = Object.keys(MEDICAL_REPORT_CATEGORY_LABELS) as MedicalReportCategory[];

/** Patient dashboard card: upload PDF/JPG/PNG reports and list own files with open/download. */
export function MedicalReportsCard({ session }: { session: Session }) {
  const reports = useQuery(`medical-reports-mine:${session.user.id}`, () =>
    api<MedicalReport[]>('/medical-reports/mine', { token: session.accessToken }),
  );
  const [category, setCategory] = useState<MedicalReportCategory>('BLOOD_TESTS');
  const [reportDate, setReportDate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !reportDate) {
      setFeedback({ tone: 'error', message: 'Choose a category, report date and file.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const form = new FormData();
      form.set('category', category);
      form.set('reportDate', reportDate);
      form.set('file', file);
      await apiForm<MedicalReport>('/medical-reports/mine', form, session.accessToken);
      setFile(null);
      setFeedback({ tone: 'success', message: 'Report uploaded.' });
      reports.reload();
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const openReport = async (id: string) => {
    setFeedback(null);
    try {
      const download = await api<MedicalReportDownload>(`/medical-reports/mine/${id}/download`, { token: session.accessToken });
      window.open(download.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    }
  };

  return (
    <section aria-labelledby="medical-reports-heading" className="space-y-3">
      <h2 id="medical-reports-heading" className="text-lg font-semibold text-foreground">
        Medical reports
      </h2>
      <Card className="[--card-spacing:--spacing(5)]">
        <CardContent className="space-y-5">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={upload}>
            <div className="space-y-2">
              <Label htmlFor="report-category">Category</Label>
              <select
                id="report-category"
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
              <Label htmlFor="report-date">Report date</Label>
              <Input id="report-date" type="date" required value={reportDate} onChange={(event) => setReportDate(event.target.value)} className="h-10 bg-card" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="report-file">File (PDF, JPG or PNG, max 10 MB)</Label>
              <Input
                id="report-file"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                className="h-10 bg-card"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="lg" className="h-10 gap-2" disabled={busy}>
                <FileUpIcon aria-hidden />
                {busy ? 'Uploading…' : 'Upload report'}
              </Button>
            </div>
          </form>

          {feedback && <Alert tone={feedback.tone === 'success' ? 'success' : 'error'}>{feedback.message}</Alert>}

          {reports.loading && !reports.data && <Spinner label="Loading your reports…" />}
          {reports.error && (
            <Alert
              action={
                <Button size="sm" variant="outline" onClick={reports.reload}>
                  Try again
                </Button>
              }
            >
              {reports.error}
            </Alert>
          )}
          {reports.data && reports.data.length === 0 && (
            <EmptyState title="No reports uploaded yet" icon={FolderOpenIcon}>
              <p>Blood tests, imaging and other documents you upload will appear here.</p>
            </EmptyState>
          )}
          {reports.data && reports.data.length > 0 && (
            <ul className="divide-y rounded-xl border">
              {reports.data.map((report) => (
                <li key={report.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{report.originalFilename}</p>
                    <p className="text-sm text-muted-foreground">
                      {MEDICAL_REPORT_CATEGORY_LABELS[report.category]} · {formatDate(report.reportDate, { weekday: undefined })}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void openReport(report.id)}>
                    Open / download
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
