'use client';

import { CheckIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Choice<T extends string> {
  value: T;
  title: string;
  description: string;
  icon: LucideIcon;
}

/**
 * Selectable cards that behave as one group of radio buttons: a real radio input sits inside each card, so arrow keys, focus and
 * screen readers work as they do for any radio group, and the whole card is the click target.
 */
export function ChoiceCards<T extends string>({
  legend,
  name,
  value,
  onChange,
  choices,
  disabled = false,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  choices: Choice<T>[];
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-foreground">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {choices.map(({ value: option, title, description, icon: Icon }) => (
          <label
            key={option}
            className={cn(
              'relative flex cursor-pointer gap-3 rounded-xl border bg-card p-4 shadow-xs transition-all',
              'hover:border-primary/40 has-checked:border-primary has-checked:bg-accent/50 has-checked:shadow-sm',
              'has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:cursor-not-allowed has-disabled:opacity-60',
            )}
          >
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} className="peer sr-only" />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground peer-checked:bg-primary peer-checked:text-primary-foreground" aria-hidden>
              <Icon className="size-4.5" />
            </span>
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm font-semibold text-foreground">{title}</span>
              <span className="block text-sm text-muted-foreground">{description}</span>
            </span>
            <CheckIcon className="absolute top-3 right-3 size-4 text-primary opacity-0 peer-checked:opacity-100" aria-hidden />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
