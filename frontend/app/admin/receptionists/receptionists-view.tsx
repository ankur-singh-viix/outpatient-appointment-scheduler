'use client';

import { UserPlusIcon, UsersIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, EmptyState, PageHeader, Spinner } from '@/components/common';
import { Field, controlClass, fieldProps } from '@/components/form-field';
import { RequireRole } from '@/components/require-role';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import type { AdminReceptionist, Clinic, EmailStatus, InviteDelivery, Session } from '@/lib/types';
import { cn } from '@/lib/utils';

export function AdminReceptionistsPage() {
  return (
    <RequireRole role="ADMIN" nextPath="/admin/receptionists">
      {(session) => <Receptionists session={session} />}
    </RequireRole>
  );
}

type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;

/** Says what really happened to an invitation: only "sent" when an email provider accepted it. */
function inviteNotice(invite: InviteDelivery, who: { name: string; email: string }, added: boolean): Notice {
  const lead = added ? `Added ${who.name}. ` : '';
  if (invite.status === 'sent') {
    return { tone: 'success', message: `${lead}The email provider accepted the invitation for ${who.email}. It can take a minute to arrive (check spam). The link works once and expires in 72 hours.` };
  }
  if (invite.status === 'logged') {
    return { tone: 'info', message: `${lead}Development mode: no email was sent. The invitation link was printed in the backend terminal, marked [DEV ONLY]. Copy it from there.` };
  }
  return {
    tone: 'error',
    message: `${lead}The invitation email was NOT sent${invite.reason ? `: ${invite.reason}` : '.'}${added ? ' The account was created; use “Resend invitation” once this is fixed.' : ''}`,
  };
}

/** How email is delivered right now, before anyone is invited. */
function EmailBanner({ status }: { status: EmailStatus }) {
  if (status.mode === 'disabled') {
    return <Alert>{`Email is not set up${status.problem ? `: ${status.problem}` : '.'} Receptionists can be added, but no invitation can be emailed until it is.`}</Alert>;
  }
  if (status.mode === 'dev-log') {
    return <Alert tone="info">Development mode: emails are not sent. Invitation links are printed in the backend terminal, marked [DEV ONLY].</Alert>;
  }
  if (status.testingSender) {
    return <Alert tone="info">Using Resend&apos;s testing sender: invitations reach only your own Resend account&apos;s email address. Verify a domain in Resend and set EMAIL_FROM to email anyone else.</Alert>;
  }
  return <p className="text-sm text-muted-foreground">Email delivery: Resend. Invitations are emailed to the receptionist.</p>;
}

function Receptionists({ session }: { session: Session }) {
  const list = useQuery(`admin-receptionists:${session.user.id}`, () => api<AdminReceptionist[]>('/admin/receptionists', { token: session.accessToken }));
  const clinics = useQuery('clinics', () => api<Clinic[]>('/clinics'));
  const emailStatus = useQuery(`admin-email-status:${session.user.id}`, () => api<EmailStatus>('/admin/email-status', { token: session.accessToken }));
  const [notice, setNotice] = useState<Notice>(null);

  const people = list.data ?? list.previous;
  const clinicList = clinics.data ?? clinics.previous;
  const changed = (next: Notice) => {
    setNotice(next);
    list.reload();
  };

  return (
    <div className="animate-in fade-in-0 space-y-6 duration-300">
      <PageHeader title="Receptionists" description="Add front desk staff and choose which clinic each one works at. They set their own password from an emailed link." />
      {emailStatus.data && <EmailBanner status={emailStatus.data} />}
      {notice && <Alert tone={notice.tone}>{notice.message}</Alert>}
      {(list.loading && !people) || (clinics.loading && !clinicList) ? <Spinner label="Loading…" /> : null}
      {(list.error || clinics.error) && <Alert>{list.error ?? clinics.error}</Alert>}
      {people && clinicList && (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <AddReceptionist session={session} clinics={clinicList} onDone={changed} />
          <Card className="[--card-spacing:--spacing(6)]">
            <CardHeader>
              <CardTitle as="h2" className="text-lg font-semibold">
                Your receptionists
              </CardTitle>
              <CardDescription>Each works at one clinic and sees only that clinic&apos;s doctors and appointments. Changing the clinic takes effect at once.</CardDescription>
            </CardHeader>
            <CardContent>
              {people.length === 0 ? (
                <EmptyState title="No receptionists yet" icon={UsersIcon}>
                  <p>Add the first one with the form. They get an email with a link to choose their password.</p>
                </EmptyState>
              ) : (
                <ul className="divide-y rounded-xl border bg-card" aria-label="Receptionists">
                  {people.map((person) => (
                    <Row key={`${person.id}:${person.clinic?.id ?? ''}`} session={session} person={person} clinics={clinicList} onDone={changed} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function ClinicSelect({ id, value, clinics, onChange, label }: { id: string; value: string; clinics: Clinic[]; onChange: (value: string) => void; label: string }) {
  return (
    <select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className={cn(controlClass, 'h-10')}>
      {!value && <option value="">Choose a clinic…</option>}
      {clinics.map((clinic) => (
        <option key={clinic.id} value={clinic.id}>
          {clinic.name}
        </option>
      ))}
    </select>
  );
}

function AddReceptionist({ session, clinics, onDone }: { session: Session; clinics: Clinic[]; onDone: (notice: Notice) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [clinicId, setClinicId] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; clinic?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (name.trim().length < 2) found.name = 'Enter the receptionist’s full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) found.email = 'Enter a valid email address.';
    if (!clinicId) found.clinic = 'Choose the clinic they work at.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<AdminReceptionist & { invite: InviteDelivery }>('/admin/receptionists', {
        method: 'POST',
        token: session.accessToken,
        body: { name: name.trim(), email: email.trim(), clinicId },
      });
      onDone(inviteNotice(created.invite, created, true));
      setName('');
      setEmail('');
      setClinicId('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="[--card-spacing:--spacing(6)]">
      <CardHeader>
        <CardTitle as="h2" className="text-lg font-semibold">
          Add a receptionist
        </CardTitle>
        <CardDescription>They are sent a link to choose their own password. You never see or set it.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field id="new-name" label="Full name" error={errors.name}>
            <Input {...fieldProps('new-name', errors.name)} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
          </Field>
          <Field id="new-email" label="Email" error={errors.email}>
            <Input {...fieldProps('new-email', errors.email)} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" />
          </Field>
          <Field id="new-clinic" label="Clinic" error={errors.clinic}>
            <select {...fieldProps('new-clinic', errors.clinic)} value={clinicId} onChange={(e) => setClinicId(e.target.value)} className={cn(controlClass, 'h-10')}>
              <option value="">Choose a clinic…</option>
              {clinics.map((clinic) => (
                <option key={clinic.id} value={clinic.id}>
                  {clinic.name}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" size="lg" disabled={busy} className="h-10 gap-2">
            <UserPlusIcon aria-hidden />
            {busy ? 'Adding…' : 'Add and send invitation'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Row({ session, person, clinics, onDone }: { session: Session; person: AdminReceptionist; clinics: Clinic[]; onDone: (notice: Notice) => void }) {
  const [clinicId, setClinicId] = useState(person.clinic?.id ?? '');
  const [busy, setBusy] = useState<'clinic' | 'invite' | null>(null);

  const run = async (kind: 'clinic' | 'invite') => {
    setBusy(kind);
    try {
      if (kind === 'clinic') {
        const moved = await api<AdminReceptionist>(`/admin/receptionists/${person.id}/clinic`, { method: 'PUT', token: session.accessToken, body: { clinicId } });
        onDone({ tone: 'success', message: `${moved.name} now works at ${moved.clinic?.name}. They see only that clinic from now on.` });
      } else {
        const sent = await api<{ invite: InviteDelivery }>(`/admin/receptionists/${person.id}/invitation`, { method: 'POST', token: session.accessToken });
        onDone(inviteNotice(sent.invite, person, false));
      }
    } catch (err) {
      onDone({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{person.name}</p>
          <p className="truncate text-sm text-muted-foreground">{person.email}</p>
        </div>
        <Badge variant="secondary" className={person.invitePending ? 'bg-amber-50 font-semibold text-amber-800' : 'bg-accent font-semibold text-accent-foreground'}>
          {person.invitePending ? 'Invitation pending' : 'Active'}
        </Badge>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <ClinicSelect id={`clinic-${person.id}`} label={`Clinic for ${person.name}`} value={clinicId} clinics={clinics} onChange={setClinicId} />
        </div>
        <Button type="button" variant="outline" className="h-10" disabled={busy !== null || !clinicId || clinicId === person.clinic?.id} onClick={() => void run('clinic')} aria-label={`Save clinic for ${person.name}`}>
          {busy === 'clinic' ? 'Saving…' : 'Save clinic'}
        </Button>
        {person.invitePending && (
          <Button type="button" variant="outline" className="h-10" disabled={busy !== null} onClick={() => void run('invite')} aria-label={`Resend invitation to ${person.name}`}>
            {busy === 'invite' ? 'Sending…' : 'Resend invitation'}
          </Button>
        )}
      </div>
    </li>
  );
}
