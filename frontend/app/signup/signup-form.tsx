'use client';

import { EyeIcon, EyeOffIcon, MailCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/common';
import { Field, fieldProps } from '@/components/form-field';
import { SIGNUP_STEPS, Stepper } from '@/components/stepper';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, api, errorMessage } from '@/lib/api';
import { saveSignupDraft } from '@/lib/signup-draft';
import { fieldErrorsFromApi, validateAccount, without, type Errors } from '@/lib/validation';

interface SentResponse {
  resendAvailableInSeconds: number;
  /** "server-log" when this server only prints codes (development) instead of emailing them. */
  delivery: 'email' | 'server-log';
}

export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const startEmail = params.get('email') ?? '';
  // Signing in with an unverified email sends people here to enter their code.
  const [stage, setStage] = useState<'account' | 'verify'>(params.get('step') === 'verify' && startEmail ? 'verify' : 'account');
  const [email, setEmail] = useState(startEmail);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devHint, setDevHint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const sent = (response: SentResponse, message: string) => {
    setResendIn(response.resendAvailableInSeconds);
    setDevHint(response.delivery === 'server-log');
    setNotice(message);
  };

  const submitAccount = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateAccount({ email, password });
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;

    setSubmitting(true);
    try {
      const response = await api<SentResponse>('/auth/register', {
        method: 'POST',
        body: { email: email.trim(), password },
      });
      sent(response, `We sent a 6-digit code to ${email.trim().toLowerCase()}.`);
      setStage('verify');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ email: 'An account with this email already exists.' });
      } else if (error instanceof ApiError && error.status === 429) {
        // A code went out moments ago: carry on to the code step instead of asking for a second one.
        setResendIn(error.retryAfterSeconds ?? 30);
        setNotice(`A code was sent to ${email.trim().toLowerCase()} a moment ago. Enter it below.`);
        setStage('verify');
      } else if (error instanceof ApiError && error.status === 400) {
        const fromServer = fieldErrorsFromApi(error.details);
        setErrors(fromServer);
        if (!Object.keys(fromServer).length) setFormError(error.message);
      } else {
        setFormError(errorMessage(error));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!/^\d{6}$/.test(code)) {
      setErrors({ code: 'Enter the 6-digit code from your email.' });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const response = await api<{ email: string; signupToken: string }>('/auth/verify-email', {
        method: 'POST',
        body: { email: email.trim(), code },
      });
      saveSignupDraft({ email: response.email, signupToken: response.signupToken });
      router.push('/onboarding');
    } catch (error) {
      setFormError(errorMessage(error));
      setSubmitting(false);
    }
  };

  const resend = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const response = await api<SentResponse>('/auth/resend-code', { method: 'POST', body: { email: email.trim() } });
      setCode('');
      sent(response, 'A new code is on its way. The previous one no longer works.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) setResendIn(error.retryAfterSeconds ?? 30);
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-6 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
      <Stepper steps={SIGNUP_STEPS} current={stage === 'account' ? 0 : 1} />

      {stage === 'account' ? (
        <Card className="[--card-spacing:--spacing(6)]">
          <form onSubmit={submitAccount} noValidate className="contents">
            <CardHeader>
              <p className="text-xs font-semibold tracking-widest text-primary uppercase">Join CareSlot</p>
              <CardTitle as="h1" className="text-2xl font-bold">
                Create your account
              </CardTitle>
              <CardDescription>Find doctors, book visits and manage your appointments in one place.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {formError && <Alert>{formError}</Alert>}
              <Field id="signup-email" label="Email address" error={errors.email}>
                <Input
                  {...fieldProps('signup-email', errors.email)}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setErrors((current) => without(current, 'email'));
                  }}
                  className="h-10"
                />
              </Field>
              <Field id="signup-password" label="Password" error={errors.password} hint="Use at least 8 characters.">
                <div className="relative">
                  <Input
                    {...fieldProps('signup-password', errors.password, 'Use at least 8 characters.')}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setErrors((current) => without(current, 'password'));
                    }}
                    className="h-10 pr-11"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((shown) => !shown)}
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                  >
                    {showPassword ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
                  </Button>
                </div>
              </Field>
              <Button type="submit" size="lg" disabled={submitting} className="h-10 w-full">
                {submitting ? 'Sending code…' : 'Continue'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <Link href="/login" className="font-medium text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </CardContent>
          </form>
        </Card>
      ) : (
        <Card className="[--card-spacing:--spacing(6)]">
          <form onSubmit={submitCode} noValidate className="contents">
            <CardHeader>
              <span className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden>
                <MailCheckIcon className="size-5" />
              </span>
              <CardTitle as="h1" className="text-2xl font-bold">
                Check your email
              </CardTitle>
              <CardDescription>
                Enter the 6-digit code we sent to <span className="font-medium text-foreground">{email.trim().toLowerCase()}</span>. It
                expires in 15 minutes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {notice && <Alert tone="success">{notice}</Alert>}
              {devHint && (
                <Alert tone="info">
                  Development mode: no email is sent. The code is printed in the backend terminal.
                </Alert>
              )}
              {formError && <Alert>{formError}</Alert>}
              <Field id="verify-code" label="Verification code" error={errors.code}>
                <Input
                  {...fieldProps('verify-code', errors.code)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                    setErrors((current) => without(current, 'code'));
                  }}
                  className="h-12 text-center font-mono text-2xl tracking-[0.5em]"
                />
              </Field>
              <Button type="submit" size="lg" disabled={submitting} className="h-10 w-full">
                {submitting ? 'Checking…' : 'Verify and continue'}
              </Button>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <Button type="button" variant="link" className="h-auto p-0" disabled={submitting || resendIn > 0} onClick={resend}>
                  {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-muted-foreground"
                  onClick={() => {
                    setStage('account');
                    setFormError(null);
                    setNotice(null);
                    setCode('');
                  }}
                >
                  Use a different email
                </Button>
              </div>
            </CardContent>
          </form>
        </Card>
      )}
    </div>
  );
}
