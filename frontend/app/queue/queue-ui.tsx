'use client';

import { Alert } from '@/components/common';
import { Button } from '@/components/ui/button';
import { timeAgo } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { STATUS_LABEL } from '@/lib/queue-view';
import type { QueueStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/** A token number, large and easy to read from a distance. */
export function TokenBadge({ token, size = 'md', className }: { token: number; size?: 'md' | 'lg' | 'xl'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground tabular-nums',
        size === 'md' && 'min-w-10 px-2 py-0.5 text-base',
        size === 'lg' && 'min-w-14 px-3 py-1 text-2xl',
        size === 'xl' && 'min-w-24 px-5 py-2 text-5xl',
        className,
      )}
      aria-label={`Token ${token}`}
    >
      {token}
    </span>
  );
}

const STATUS_TONE: Record<QueueStatus, string> = {
  WAITING: 'bg-amber-50 text-amber-800',
  SERVING: 'bg-emerald-50 text-emerald-800',
  COMPLETED: 'bg-sky-50 text-sky-800',
  CHECKED_OUT: 'bg-slate-100 text-slate-700',
  SKIPPED: 'bg-red-50 text-red-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
};

export function QueueStatusPill({ status }: { status: QueueStatus }) {
  return <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold', STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>;
}

/**
 * How fresh what is on screen is, in words: "Updated just now", a notice when it is getting old, and a notice with a Retry when the
 * last refresh failed (the last good information stays visible, and says so).
 */
export function Freshness({ updatedAt, stale, error, onRetry, className }: { updatedAt: number | null; stale: boolean; error: string | null; onRetry: () => void; className?: string }) {
  const now = useNow(5_000);
  const ago = updatedAt === null ? null : timeAgo(new Date(updatedAt).toISOString(), now);
  const retry = (
    <Button type="button" size="sm" variant="outline" onClick={onRetry}>
      Retry
    </Button>
  );
  if (error) {
    return (
      <Alert action={retry}>
        Could not refresh the queue{ago ? `. Showing what it was ${ago}` : ''}. {error}
      </Alert>
    );
  }
  if (stale) {
    return (
      <Alert tone="info" action={retry}>
        This may be out of date: last updated {ago}.
      </Alert>
    );
  }
  return ago ? <p className={cn('text-xs text-muted-foreground', className)}>Updated {ago}</p> : null;
}
