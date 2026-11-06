'use client';

import { BuildingIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, EmptyState, PageHeader, Spinner } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import type { ReceptionDoctor, Session } from '@/lib/types';
import { AppointmentsPanel } from './appointments-panel';
import { BookPanel } from './book-panel';

export function ReceptionPage() {
  return (
    <RequireRole role="RECEPTIONIST" nextPath="/reception">
      {(session) => <FrontDesk session={session} />}
    </RequireRole>
  );
}

function FrontDesk({ session }: { session: Session }) {
  const doctors = useQuery(`reception-doctors:${session.user.id}`, () => api<ReceptionDoctor[]>('/receptionist/doctors', { token: session.accessToken }));
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped after any booking, move or cancellation, so the appointment list fetches again.
  const [version, setVersion] = useState(0);
  const changed = (message: string) => {
    setNotice(message);
    setVersion((current) => current + 1);
  };

  const list = doctors.data ?? doctors.previous;
  return (
    <div className="animate-in fade-in-0 space-y-6 duration-300">
      <PageHeader title="Front desk" description="Book, move and cancel appointments for patients at your clinic. Slot availability is live." />
      {doctors.loading && !list && <Spinner label="Loading your clinic…" />}
      {doctors.error && (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={doctors.reload}>
              Try again
            </Button>
          }
        >
          Could not load your clinic. {doctors.error}
        </Alert>
      )}
      {list && list.length === 0 && (
        <EmptyState title="No clinic assigned" icon={BuildingIcon}>
          <p>Your account is not linked to a clinic yet, so there are no doctors to book. Ask an administrator to assign you to a clinic.</p>
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <>
          {notice && <Alert tone="success">{notice}</Alert>}
          <Tabs defaultValue="book" className="gap-6">
            <TabsList variant="line" className="w-full justify-start border-b">
              <TabsTrigger value="book" className="flex-none px-4">
                New booking
              </TabsTrigger>
              <TabsTrigger value="appointments" className="flex-none px-4">
                Appointments
              </TabsTrigger>
            </TabsList>
            <TabsContent value="book">
              <BookPanel session={session} doctors={list} onBooked={changed} />
            </TabsContent>
            <TabsContent value="appointments">
              <AppointmentsPanel session={session} doctors={list} version={version} onChanged={changed} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
