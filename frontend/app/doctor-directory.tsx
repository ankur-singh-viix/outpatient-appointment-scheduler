'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Alert, Avatar, EmptyState } from '@/components/common';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatFee, initials, summariseWeeklyHours } from '@/lib/format';
import { useDebounced, useQuery } from '@/lib/hooks';
import type { Doctor, Specialty } from '@/lib/types';

export function DoctorDirectory() {
  const [search, setSearch] = useState('');
  const [specialtyId, setSpecialtyId] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search.trim(), 300);

  const specialties = useQuery('specialties', () => api<Specialty[]>('/specialties'));
  const params = new URLSearchParams();
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (specialtyId) params.set('specialtyId', specialtyId);
  const query = params.toString();
  const doctors = useQuery(`doctors?${query}`, () => api<Doctor[]>(`/doctors${query ? `?${query}` : ''}`));

  // Keep the previous results on screen while a new search loads.
  const list = doctors.data ?? (doctors.loading ? doctors.previous : undefined);
  const filtersActive = Boolean(debouncedSearch || specialtyId);

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-4">
          <label className="block">
            <span className="sr-only">Search doctors</span>
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by doctor name or specialty, e.g. “Rao” or “Dermatology”"
              className="h-11 text-base"
            />
          </label>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by specialty">
            <FilterChip active={specialtyId === null} onClick={() => setSpecialtyId(null)}>
              All specialties
            </FilterChip>
            {specialties.data?.map((specialty) => (
              <FilterChip
                key={specialty.id}
                active={specialtyId === specialty.id}
                onClick={() => setSpecialtyId(specialtyId === specialty.id ? null : specialty.id)}
              >
                {specialty.name}
              </FilterChip>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground" aria-live="polite">
        {list && (
          <p>
            {list.length} doctor{list.length === 1 ? '' : 's'} available
          </p>
        )}
        {doctors.loading && list && <p>Updating…</p>}
      </div>

      {doctors.error && (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={doctors.reload}>
              Try again
            </Button>
          }
        >
          Could not load doctors. {doctors.error}
        </Alert>
      )}

      {!list && doctors.loading && <DoctorListSkeleton />}

      {list && list.length === 0 && (
        <EmptyState title="No doctors match your search">
          {filtersActive && (
            <Button
              variant="link"
              onClick={() => {
                setSearch('');
                setSpecialtyId(null);
              }}
            >
              Clear filters
            </Button>
          )}
        </EmptyState>
      )}

      {list && list.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2">
          {list.map((doctor) => (
            <li key={doctor.id}>
              <DoctorCard doctor={doctor} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      size="lg"
      variant={active ? 'default' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
      className="rounded-full"
    >
      {children}
    </Button>
  );
}

function DoctorCard({ doctor }: { doctor: Doctor }) {
  const timings = summariseWeeklyHours(doctor.weeklyHours);
  return (
    <article className="h-full">
    <Card className="h-full [--card-spacing:--spacing(5)]">
      <CardContent className="flex h-full flex-col gap-4">
        <div className="flex gap-4">
          <Avatar text={initials(doctor.name)} />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">{doctor.name}</h2>
            <p className="text-sm font-medium text-primary">{doctor.specialty.name}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {doctor.clinic.name} · {doctor.clinic.address}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Consultation fee</dt>
            <dd className="font-semibold text-foreground">{formatFee(doctor.consultationFee)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Visit length</dt>
            <dd className="font-semibold text-foreground">{doctor.consultationMinutes} min</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Available timings</dt>
            <dd className="mt-0.5 space-y-0.5 font-medium text-foreground">
              {timings.length ? timings.map((line) => <p key={line}>{line}</p>) : <p>No regular hours set</p>}
            </dd>
          </div>
        </dl>

        <Link href={`/doctors/${doctor.id}`} className={buttonVariants({ size: 'lg', className: 'mt-auto w-full' })}>
          Book appointment
        </Link>
      </CardContent>
    </Card>
    </article>
  );
}

function DoctorListSkeleton() {
  return (
    <ul className="grid gap-4 md:grid-cols-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li key={i}>
          <Card className="h-64 [--card-spacing:--spacing(5)]">
            <CardContent className="space-y-6">
              <div className="flex gap-4">
                <Skeleton className="size-14 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
              <Skeleton className="h-24" />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
