'use client';

import { BellIcon, BellRingIcon, CalendarCheckIcon, CalendarClockIcon, CalendarXIcon, CreditCardIcon, RotateCcwIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { NotificationItem, Session } from '@/lib/types';

export function NotificationsView() {
  return (
    <RequireRole role="PATIENT" nextPath="/notifications">
      {(session) => <Notifications session={session} />}
    </RequireRole>
  );
}

const ICONS: [prefix: string, icon: ReactNode][] = [
  ['booking-confirmed', <CalendarCheckIcon key="confirmed" className="size-5" />],
  ['booking-rescheduled', <CalendarClockIcon key="rescheduled" className="size-5" />],
  ['booking-cancelled', <CalendarXIcon key="cancelled" className="size-5" />],
  ['payment', <CreditCardIcon key="payment" className="size-5" />],
  ['refund', <RotateCcwIcon key="refund" className="size-5" />],
  ['reminder', <BellRingIcon key="reminder" className="size-5" />],
];
const DEFAULT_ICON = <BellIcon className="size-5" />;
const iconFor = (kind: string): ReactNode => ICONS.find(([prefix]) => kind.startsWith(prefix))?.[1] ?? DEFAULT_ICON;

function Notifications({ session }: { session: Session }) {
  const list = useQuery(`notifications:${session.user.id}`, () => api<NotificationItem[]>('/notifications/mine', { token: session.accessToken }));
  const items = list.data ?? list.previous;
  if (!items && list.loading) return <Spinner label="Loading your notifications…" />;
  if (list.error) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={list.reload}>
            Try again
          </Button>
        }
      >
        Could not load your notifications. {list.error}
      </Alert>
    );
  }
  if (!items || items.length === 0) {
    return (
      <EmptyState title="Nothing here yet" icon={BellIcon}>
        <p>Confirmations, payment and refund updates, and appointment reminders will appear here. We also email them to {session.user.email}.</p>
        <Link href="/" className={buttonVariants({ size: 'lg', className: 'h-10' })}>
          Find a doctor
        </Link>
      </EmptyState>
    );
  }

  const upcoming = items.filter((item) => item.status !== 'SENT').sort((a, b) => a.at.localeCompare(b.at));
  const sent = items.filter((item) => item.status === 'SENT');

  return (
    <div className="space-y-8">
      {upcoming.length > 0 && <Group heading="Upcoming reminders" items={upcoming} />}
      {sent.length > 0 && <Group heading="Received" items={sent} />}
    </div>
  );
}

function Group({ heading, items }: { heading: string; items: NotificationItem[] }) {
  const id = heading.toLowerCase().replace(/\s+/g, '-');
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-semibold text-foreground">
        {heading}
      </h2>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id}>
            <Row item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ item }: { item: NotificationItem }) {
  const scheduled = item.status !== 'SENT';
  return (
    <Card className="[--card-spacing:--spacing(4)]">
      <CardContent className="flex gap-3">
        <span
          className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', scheduled ? 'bg-amber-50 text-amber-700' : 'bg-accent text-accent-foreground')}
          aria-hidden
        >
          {iconFor(item.kind)}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground">{item.subject}</span>
            <Badge variant="secondary" className={cn('font-semibold', scheduled ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700')}>
              {scheduled ? 'Scheduled' : 'Sent'}
            </Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            {scheduled ? 'Will be sent ' : 'Sent '}
            {formatDateTime(item.at)} · by email
          </p>
          <details className="text-sm">
            <summary className="w-fit cursor-pointer rounded font-medium text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
              Read message
            </summary>
            <p className="mt-2 whitespace-pre-line text-foreground/80">{item.body}</p>
          </details>
        </div>
      </CardContent>
    </Card>
  );
}
