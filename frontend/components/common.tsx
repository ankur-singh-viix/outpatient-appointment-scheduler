import { AlertCircleIcon, CheckCircle2Icon, InfoIcon, Loader2Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert as UiAlert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// App-level building blocks composed from the shadcn/ui primitives in components/ui.

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
      <Loader2Icon className="size-5 animate-spin text-primary" aria-hidden />
      {label}
    </div>
  );
}

const ALERT_TONES = {
  error: { variant: 'destructive', Icon: AlertCircleIcon, className: 'border-destructive/30 bg-destructive/5', role: 'alert' },
  success: { variant: 'default', Icon: CheckCircle2Icon, className: 'border-emerald-200 bg-emerald-50 text-emerald-800', role: 'status' },
  info: { variant: 'default', Icon: InfoIcon, className: 'border-sky-200 bg-sky-50 text-sky-800', role: 'status' },
} as const;

export function Alert({
  tone = 'error',
  children,
  action,
}: {
  tone?: keyof typeof ALERT_TONES;
  children: ReactNode;
  action?: ReactNode;
}) {
  const { variant, Icon, className, role } = ALERT_TONES[tone];
  return (
    <UiAlert variant={variant} role={role} className={cn('py-3', className)}>
      <Icon aria-hidden />
      <AlertDescription className="text-current">{children}</AlertDescription>
      {action && <AlertAction className="top-1/2 -translate-y-1/2">{action}</AlertAction>}
    </UiAlert>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
      <p className="font-semibold text-foreground">{title}</p>
      {children && <div className="mt-2 flex flex-col items-center gap-3 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700',
  PENDING: 'bg-amber-50 text-amber-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
  COMPLETED: 'bg-sky-50 text-sky-700',
  NO_SHOW: 'bg-red-50 text-red-700',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="secondary" className={cn('font-semibold', STATUS_STYLES[status] ?? STATUS_STYLES.CANCELLED)}>
      {status.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
    </Badge>
  );
}

export function Avatar({ text }: { text: string }) {
  return (
    <div
      aria-hidden
      className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-lg font-bold text-accent-foreground ring-1 ring-primary/10"
    >
      {text}
    </div>
  );
}
