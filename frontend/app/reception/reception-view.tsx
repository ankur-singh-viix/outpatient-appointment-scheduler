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
import { PrescriptionsPanel } from './prescriptions-panel';
import { QueuePanel } from './queue-panel';
import { ReportsPanel } from './reports-panel';

export function ReceptionPage() {
  return (
    <RequireRole role="RECEPTIONIST" nextPath="/reception">
      {(session) => <FrontDesk session={session} />}
    </RequireRole>
  );
}

type DeskTab = 'queue' | 'appointments' | 'book' | 'prescriptions' | 'reports';

function FrontDesk({ session }: { session: Session }) {
  const doctors = useQuery(`reception-doctors:${session.user.id}`, () => api<ReceptionDoctor[]>('/receptionist/doctors', { token: session.accessToken }));
  const [notice, setNotice] = useState<string | null>(null);
  // Queue is the default: check-in and tokens live here. Booking is a separate tab.
  const [tab, setTab] = useState<DeskTab>('queue');
  // Bumped after any booking, move, cancellation or check-in, so lists and the queue refresh.
  const [version, setVersion] = useState(0);
  const changed = (message: string, nextTab?: DeskTab) => {
    setNotice(message);
    setVersion((current) => current + 1);
    if (nextTab) setTab(nextTab);
  };

  const list = doctors.data ?? doctors.previous;
  return (
    <div className="animate-in fade-in-0 space-y-6 duration-300">
      <PageHeader
        title="Front desk"
        description="Check patients in for today's confirmed appointments, manage the live queue, and book or move visits for the doctors who assigned you."
      />
      {doctors.loading && !list && <Spinner label="Loading your doctors…" />}
      {doctors.error && (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={doctors.reload}>
              Try again
            </Button>
          }
        >
          Could not load your doctors. {doctors.error}
        </Alert>
      )}
      {list && list.length === 0 && (
        <EmptyState title="No doctor assigned you" icon={BuildingIcon}>
          <p>A doctor must assign you as their receptionist before you can manage their appointments. Ask your doctor to assign you from their Profile page.</p>
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <>
          {notice && <Alert tone="success">{notice}</Alert>}
          <Tabs value={tab} onValueChange={(value) => setTab(value as DeskTab)} className="gap-6">
            <TabsList variant="line" className="w-full justify-start border-b">
              <TabsTrigger value="queue" className="flex-none px-4">
                Queue &amp; check-in
              </TabsTrigger>
              <TabsTrigger value="appointments" className="flex-none px-4">
                Appointments
              </TabsTrigger>
              <TabsTrigger value="book" className="flex-none px-4">
                New booking
              </TabsTrigger>
              <TabsTrigger value="prescriptions" className="flex-none px-4">
                Prescriptions
              </TabsTrigger>
              <TabsTrigger value="reports" className="flex-none px-4">
                Reports
              </TabsTrigger>
            </TabsList>
            <TabsContent value="queue">
              <QueuePanel session={session} doctors={list} refreshKey={version} />
            </TabsContent>
            <TabsContent value="appointments">
              <AppointmentsPanel session={session} doctors={list} version={version} onChanged={changed} onOpenQueue={() => setTab('queue')} />
            </TabsContent>
            <TabsContent value="book">
              <BookPanel session={session} doctors={list} onBooked={(message) => changed(message)} />
            </TabsContent>
            <TabsContent value="prescriptions">
              <PrescriptionsPanel session={session} />
            </TabsContent>
            <TabsContent value="reports">
              <ReportsPanel session={session} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
