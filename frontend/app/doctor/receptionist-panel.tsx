'use client';

import { UserRoundCogIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import type { DoctorReceptionist, Session } from '@/lib/types';

/**
 * Lets the signed-in doctor assign, change or remove the receptionist who may manage their appointments and queue.
 * Prefer assigning by the receptionist's registered email; clinic shortlist remains as a convenience when present.
 */
export function ReceptionistPanel({ session }: { session: Session }) {
  const assigned = useQuery(`doctor-receptionist:${session.user.id}`, () =>
    api<DoctorReceptionist | null>('/doctor-portal/receptionist', { token: session.accessToken }),
  );
  const candidates = useQuery(`doctor-receptionist-candidates:${session.user.id}`, () =>
    api<DoctorReceptionist[]>('/doctor-portal/receptionist/candidates', { token: session.accessToken }),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState('');

  const current = assigned.data === undefined ? assigned.previous : assigned.data;
  const list = candidates.data ?? candidates.previous ?? [];

  const run = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setNotice({ tone: 'success', text: success });
      setEmail('');
      setPicked('');
      assigned.reload();
      candidates.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const assignByEmail = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    void run(
      () => api('/doctor-portal/receptionist', { method: 'PUT', token: session.accessToken, body: { email: trimmed } }),
      current ? 'Receptionist changed.' : 'Receptionist assigned.',
    );
  };

  if ((!current && current !== null && assigned.loading) || (candidates.loading && !list)) {
    return <Spinner label="Loading receptionist…" />;
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Receptionist
        </CardTitle>
        <CardDescription>
          Assign a registered receptionist by email so they can book, check in and print prescriptions for your patients only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {(assigned.error || candidates.error) && <Alert>{assigned.error ?? candidates.error}</Alert>}

        {current ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3">
            <div>
              <p className="font-medium text-foreground">{current.name}</p>
              <p className="text-sm text-muted-foreground">{current.email}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => api('/doctor-portal/receptionist', { method: 'DELETE', token: session.accessToken }), 'Receptionist removed.')}
            >
              Remove
            </Button>
          </div>
        ) : (
          <EmptyState title="No receptionist assigned" icon={UserRoundCogIcon}>
            <p>Enter the email they used when they registered as a receptionist.</p>
          </EmptyState>
        )}

        <form className="flex flex-wrap items-end gap-3" onSubmit={assignByEmail}>
          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <Label htmlFor="receptionist-email">{current ? 'Change by email' : 'Receptionist email'}</Label>
            <Input
              id="receptionist-email"
              type="email"
              autoComplete="off"
              placeholder="receptionist@clinic.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              className="h-9"
              required
            />
          </div>
          <Button type="submit" disabled={busy || !email.trim()}>
            {current ? 'Change' : 'Assign'}
          </Button>
        </form>

        {list.length > 0 && (
          <form
            className="flex flex-wrap items-end gap-3 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!picked) return;
              void run(
                () => api('/doctor-portal/receptionist', { method: 'PUT', token: session.accessToken, body: { receptionistUserId: picked } }),
                current ? 'Receptionist changed.' : 'Receptionist assigned.',
              );
            }}
          >
            <label className="min-w-[16rem] flex-1 space-y-1.5 text-sm">
              <span className="font-medium text-foreground">Or choose from your clinic</span>
              <select
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={picked}
                onChange={(event) => setPicked(event.target.value)}
                disabled={busy}
              >
                <option value="">Select a receptionist…</option>
                {list.map((person) => (
                  <option key={person.id} value={person.id} disabled={current?.id === person.id}>
                    {person.name} ({person.email})
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="outline" disabled={busy || !picked}>
              {current ? 'Change' : 'Assign'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
