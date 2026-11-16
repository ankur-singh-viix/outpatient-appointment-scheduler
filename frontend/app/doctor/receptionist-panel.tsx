'use client';

import { UserRoundCogIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import type { DoctorReceptionist, Session } from '@/lib/types';

/**
 * Lets the signed-in doctor assign, change or remove the receptionist who may manage their appointments and queue.
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
      assigned.reload();
      candidates.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
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
        <CardDescription>Choose who may book, check in and print prescriptions for your patients. They must already be a receptionist at your clinic.</CardDescription>
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
            <p>Assign someone from your clinic so they can manage only your appointments.</p>
          </EmptyState>
        )}

        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No receptionists are assigned to your clinic yet. Ask an administrator to add one.</p>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
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
              <span className="font-medium text-foreground">{current ? 'Change to' : 'Assign'}</span>
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
            <Button type="submit" disabled={busy || !picked}>
              {current ? 'Change' : 'Assign'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
