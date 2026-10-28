'use client';

import { CalendarDaysIcon, ClockIcon, IndianRupeeIcon, MapPinIcon, SearchIcon, StethoscopeIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Avatar, EmptyState } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDate, formatFee, formatTime, initials, relativeDay, summariseWeeklyHours } from '@/lib/format';
import { useClinicToday, useDebounced, useQuery } from '@/lib/hooks';
import type { Doctor, Specialty } from '@/lib/types';

type SortKey = 'relevance' | 'fee-asc' | 'fee-desc' | 'name';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'fee-asc', label: 'Fee: low to high' },
  { value: 'fee-desc', label: 'Fee: high to low' },
  { value: 'name', label: 'Name (A–Z)' },
];

function sortDoctors(doctors: Doctor[], sort: SortKey): Doctor[] {
  if (sort === 'relevance') return doctors;
  const copy = [...doctors];
  if (sort === 'fee-asc') copy.sort((a, b) => a.consultationFee - b.consultationFee);
  if (sort === 'fee-desc') copy.sort((a, b) => b.consultationFee - a.consultationFee);
  if (sort === 'name') copy.sort((a, b) => a.name.localeCompare(b.name));
  return copy;
}

export function DoctorDirectory() {
  const [search, setSearch] = useState('');
  const [specialtyId, setSpecialtyId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('relevance');
  const debouncedSearch = useDebounced(search.trim(), 300);

  const specialties = useQuery('specialties', () => api<Specialty[]>('/specialties'));
  const params = new URLSearchParams();
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (specialtyId) params.set('specialtyId', specialtyId);
  const query = params.toString();
  const doctors = useQuery(`doctors?${query}`, () => api<Doctor[]>(`/doctors${query ? `?${query}` : ''}`));

  // Keep the previous results on screen while a new search loads.
  const loaded = doctors.data ?? (doctors.loading ? doctors.previous : undefined);
  const list = useMemo(() => (loaded ? sortDoctors(loaded, sort) : undefined), [loaded, sort]);
  const filtersActive = Boolean(debouncedSearch || specialtyId);
  const clearFilters = () => {
    setSearch('');
    setSpecialtyId(null);
  };

  return (
    <section aria-labelledby="directory-heading" className="space-y-5">
      <h2 id="directory-heading" className="sr-only">
        Find a doctor
      </h2>
      <Card className="shadow-lg [--card-spacing:--spacing(5)]">
        <CardContent className="space-y-4">
          <div className="relative">
            <label htmlFor="doctor-search" className="sr-only">
              Search doctors
            </label>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="doctor-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by doctor name or specialty, e.g. “Rao” or “Dermatology”"
              className="h-12 pr-11 pl-11 text-base"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Clear search"
                onClick={() => setSearch('')}
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
              >
                <XIcon aria-hidden />
              </Button>
            )}
          </div>
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

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p aria-live="polite">
          {list && (
            <>
              <span className="font-semibold text-foreground">{list.length}</span> doctor{list.length === 1 ? '' : 's'} available
              {doctors.loading && ' · updating…'}
            </>
          )}
        </p>
        <label className="flex items-center gap-2">
          Sort by
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="h-9 rounded-lg border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
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
        <EmptyState title="No doctors match your search" icon={StethoscopeIcon}>
          <p>{filtersActive ? 'Try a different name or specialty, or remove a filter.' : 'No doctors are listed yet.'}</p>
          {filtersActive && (
            <Button variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </EmptyState>
      )}

      {list && list.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2">
          {list.map((doctor, index) => (
            <li
              key={doctor.id}
              className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300 fill-mode-backwards"
              style={{ animationDelay: `${Math.min(index, 5) * 50}ms` }}
            >
              <DoctorCard doctor={doctor} />
            </li>
          ))}
        </ul>
      )}
    </section>
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
      className="rounded-full px-4"
    >
      {children}
    </Button>
  );
}

function DoctorCard({ doctor }: { doctor: Doctor }) {
  const timings = summariseWeeklyHours(doctor.weeklyHours);
  const today = useClinicToday();
  const next = doctor.nextAvailable;
  return (
    <article className="h-full">
      <Card className="h-full transition-all duration-200 [--card-spacing:--spacing(5)] hover:-translate-y-0.5 hover:shadow-md hover:ring-primary/30">
        <CardContent className="flex h-full flex-col gap-4">
          <div className="flex gap-4">
            <Avatar text={initials(doctor.name)} />
            <div className="min-w-0 space-y-1">
              <h3 className="text-lg font-semibold text-foreground">{doctor.name}</h3>
              <Badge variant="secondary" className="bg-accent text-accent-foreground">
                {doctor.specialty.name}
              </Badge>
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <MapPinIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {doctor.clinic.name} · {doctor.clinic.address}
                </span>
              </p>
            </div>
          </div>

          {/* The bio is where doctors list their qualifications; shown exactly as stored, never invented. */}
          {doctor.bio && <p className="line-clamp-2 text-sm text-foreground/80">{doctor.bio}</p>}

          {/* Worked out by the server from the same rules booking uses, so this time can really be booked. */}
          <p
            className={
              next
                ? 'flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground'
                : 'flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground'
            }
          >
            <ClockIcon className="size-4 shrink-0" aria-hidden />
            {next ? (
              <span>
                Next available:{' '}
                <span className="font-semibold">
                  {relativeDay(next.date, today) ?? formatDate(next.date, { year: undefined })}, {formatTime(next.startTime)}
                </span>
              </span>
            ) : (
              <span>No free slots in the next 14 days</span>
            )}
          </p>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-muted p-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <IndianRupeeIcon className="size-3.5" aria-hidden />
                Consultation fee
              </dt>
              <dd className="mt-0.5 text-base font-semibold text-foreground">{formatFee(doctor.consultationFee)}</dd>
            </div>
            <div className="rounded-lg bg-muted p-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <ClockIcon className="size-3.5" aria-hidden />
                Visit length
              </dt>
              <dd className="mt-0.5 text-base font-semibold text-foreground">{doctor.consultationMinutes} min</dd>
            </div>
            <div className="col-span-2 rounded-lg bg-muted p-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <CalendarDaysIcon className="size-3.5" aria-hidden />
                Available timings
              </dt>
              <dd className="mt-1 space-y-0.5 font-medium text-foreground">
                {timings.length ? timings.map((line) => <p key={line}>{line}</p>) : <p>No regular hours set</p>}
              </dd>
            </div>
          </dl>

          <div className="mt-auto grid grid-cols-2 gap-2">
            <Link
              href={`/doctors/${doctor.id}`}
              aria-label={`View profile of ${doctor.name}`}
              className={buttonVariants({ variant: 'outline', size: 'lg', className: 'h-10' })}
            >
              View profile
            </Link>
            <Link
              href={`/doctors/${doctor.id}${next ? `?date=${next.date}` : ''}#book`}
              aria-label={`Book appointment with ${doctor.name}`}
              className={buttonVariants({ size: 'lg', className: 'h-10' })}
            >
              Book appointment
            </Link>
          </div>
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
          <Card className="h-72 [--card-spacing:--spacing(5)]">
            <CardContent className="space-y-6">
              <div className="flex gap-4">
                <Skeleton className="size-14 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
              <Skeleton className="h-28" />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
