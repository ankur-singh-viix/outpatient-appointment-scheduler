'use client';

import { BellIcon, BellRingIcon, CalendarCheckIcon, CalendarClockIcon, CalendarXIcon, CreditCardIcon, MailIcon, RotateCcwIcon, SmartphoneIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Alert, EmptyState, Spinner } from '@/components/common';
import { NotificationPreferences } from './notification-preferences';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, formatReminderInterval, formatTimeRange } from '@/lib/format';
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
  // Changing a preference can add or remove reminders, so the list below reloads when one changes.
  const [version, setVersion] = useState(0);
  return (
    <div className="space-y-8">
      <NotificationPreferences session={session} onChanged={() => setVersion((current) => current + 1)} />
      <NotificationList key={version} session={session} />
    </div>
  );
}

function NotificationList({ session }: { session: Session }) {
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

  // Reminders still to come are shown together per appointment, one line for each interval and channel, so the "24 hours before"
  // and "1 hour before" reminders (and their email and text versions) read as distinct reminders, not as repeats.
  const byAppointment = new Map<string, NotificationItem[]>();
  for (const item of upcoming) byAppointment.set(item.appointmentId, [...(byAppointment.get(item.appointmentId) ?? []), item]);

  return (
    <div className="space-y-8">
      {upcoming.length > 0 && (
        <section aria-labelledby="upcoming-reminders" className="space-y-3">
          <h2 id="upcoming-reminders" className="text-lg font-semibold text-foreground">
            Upcoming reminders
          </h2>
          <p className="text-sm text-muted-foreground">
            Each appointment has one reminder for every interval and channel you have chosen. Times are clinic time.
          </p>
          <ul className="space-y-3">
            {[...byAppointment.entries()].map(([appointmentId, reminders]) => (
              <li key={appointmentId}>
                <ReminderCard reminders={reminders} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {sent.length > 0 && <Group heading="Received" items={sent} />}
    </div>
  );
}

const CHANNEL_LABEL = { email: 'Email', sms: 'Text message' } as const;

function ChannelTag({ channel }: { channel: 'email' | 'sms' }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground/80">
      {channel === 'email' ? <MailIcon className="size-3" aria-hidden /> : <SmartphoneIcon className="size-3" aria-hidden />}
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

/** The reminders still to come for one appointment, earliest first: one line per interval and channel. */
function ReminderCard({ reminders }: { reminders: NotificationItem[] }) {
  const appointment = reminders[0].appointment;
  // Earliest to send first (the longer interval), email before text for the same interval.
  const ordered = [...reminders].sort((a, b) => (b.intervalHours ?? 0) - (a.intervalHours ?? 0) || a.channel.localeCompare(b.channel));
  return (
    <Card className="[--card-spacing:--spacing(4)]">
      <CardContent className="space-y-3">
        <div className="flex gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700" aria-hidden>
            <BellRingIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-foreground">{appointment ? `Reminders for ${appointment.doctorName}` : 'Appointment reminders'}</p>
            {appointment && (
              <p className="text-sm text-muted-foreground">
                {formatDate(appointment.date, { weekday: 'long' })} · {formatTimeRange(appointment.startTime, appointment.endTime)}
              </p>
            )}
          </div>
        </div>
        <ul aria-label="Scheduled reminders" className="divide-y rounded-lg border">
          {ordered.map((item) => (
            <li key={item.id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  {item.intervalHours !== null ? formatReminderInterval(item.intervalHours) : 'Reminder'}
                  <ChannelTag channel={item.channel} />
                </p>
                <Badge variant="secondary" className="bg-amber-50 font-semibold text-amber-700">
                  Scheduled
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">Will be sent {formatDateTime(item.sendAt)}</p>
              <details className="text-sm">
                <summary className="w-fit cursor-pointer rounded font-medium text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
                  Read message
                </summary>
                <p className="mt-2 whitespace-pre-line text-foreground/80">{item.body}</p>
              </details>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
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
          {item.intervalHours !== null && <p className="text-sm font-medium text-foreground/80">{formatReminderInterval(item.intervalHours)} the appointment</p>}
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>
              {scheduled ? 'Will be sent ' : 'Sent '}
              {formatDateTime(item.at)}
            </span>
            <ChannelTag channel={item.channel} />
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
