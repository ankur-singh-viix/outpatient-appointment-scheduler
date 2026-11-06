'use client';

import { UserRoundIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Alert, Spinner } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useDebounced, useQuery } from '@/lib/hooks';
import type { ReceptionPatient, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

const MIN_CHARS = 2;

/** Finds a registered patient by name, email or phone number, and shows who is chosen. */
export function PatientSearch({ session, selected, onSelect }: { session: Session; selected: ReceptionPatient | null; onSelect: (patient: ReceptionPatient | null) => void }) {
  const [text, setText] = useState('');
  const search = useDebounced(text.trim(), 300);
  const enabled = search.length >= MIN_CHARS;
  const results = useQuery(enabled && !selected ? `reception-patients:${search}` : null, () =>
    api<ReceptionPatient[]>(`/receptionist/patients?search=${encodeURIComponent(search)}`, { token: session.accessToken }),
  );

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-accent/40 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden>
            <UserRoundIcon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{selected.name}</p>
            <p className="truncate text-xs text-muted-foreground">{[selected.email, selected.phone].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onSelect(null)} aria-label={`Choose a different patient than ${selected.name}`}>
          <XIcon aria-hidden /> Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="patient-search">Find a patient</Label>
        <Input
          id="patient-search"
          type="search"
          autoComplete="off"
          placeholder="Name, email or phone number"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby="patient-search-hint"
          className="h-10 bg-card"
        />
        <p id="patient-search-hint" className="text-xs text-muted-foreground">
          Registered patients only. Type at least {MIN_CHARS} characters.
        </p>
      </div>
      {enabled && results.loading && !results.data && <Spinner label="Searching…" />}
      {results.error && <Alert>{results.error}</Alert>}
      {enabled && results.data && results.data.length === 0 && <p className="text-sm text-muted-foreground">No registered patient matches “{search}”.</p>}
      {results.data && results.data.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Matching patients">
          {results.data.map((patient) => (
            <li key={patient.id}>
              <button
                type="button"
                onClick={() => onSelect(patient)}
                className={cn('flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset')}
              >
                <span className="text-sm font-semibold text-foreground">{patient.name}</span>
                <span className="text-xs text-muted-foreground">{[patient.email, patient.phone].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
