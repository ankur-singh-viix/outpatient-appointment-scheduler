import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The four stages of creating an account, shared by the sign-up and onboarding pages. */
export const SIGNUP_STEPS = ['Account', 'Verify email', 'Role', 'Details'];

/** Shows where the visitor is in a short, linear flow. `current` is the 0-based index of the active step. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center justify-center gap-x-2 text-sm" aria-label="Progress">
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-7 items-center justify-center rounded-full text-xs font-semibold',
                done && 'bg-primary text-primary-foreground',
                active && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
                !done && !active && 'bg-muted text-muted-foreground',
              )}
              aria-hidden
            >
              {done ? <CheckIcon className="size-4" /> : index + 1}
            </span>
            <span className={cn(active ? 'font-medium text-foreground' : 'hidden text-muted-foreground sm:inline')}>
              {label}
              {done && <span className="sr-only"> (completed)</span>}
            </span>
            {index < steps.length - 1 && <span className="hidden h-px w-6 bg-border sm:block" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
