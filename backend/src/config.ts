import { existsSync } from 'node:fs';

export interface AppConfig {
  databaseUrl: string;
  jwtSecret: string;
  corsOrigins: string[];
  /** IANA zone of the clinics; decides what "today" and "now" mean for slots. */
  clinicTimezone: string;
  /** How many days ahead patients may book. */
  bookingWindowDays: number;
  /** How sign-up verification emails are delivered: Resend (needs RESEND_API_KEY), the server log (development), or not at all. */
  emailDelivery: EmailDelivery;
  resendApiKey: string;
  /** The "from" address; with Resend it must be on a domain you have verified there. */
  emailFrom: string;
  clerk: ClerkConfig;
}

export type EmailDelivery = 'resend' | 'log' | 'disabled';

/** Clerk (hosted sign-in). Off unless CLERK_SECRET_KEY is set, so the legacy login keeps working on its own. */
export interface ClerkConfig {
  enabled: boolean;
  secretKey: string;
  /** Optional PEM public key: lets tokens be verified without a network call. */
  jwtKey: string;
  /** Origins allowed to have issued a token (Clerk's `azp` claim). Defaults to the CORS origins. */
  authorizedParties: string[];
}

const DEV_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/outpatient';

/** Loads backend/.env for local runs. Hosted environments set real variables instead. */
export function loadEnvFileIfPresent(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(): AppConfig {
  // Railway sets RAILWAY_ENVIRONMENT_NAME; NODE_ENV is often left unset there so devDependencies install for the build.
  const production = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
  const required = (name: string, devDefault: string): string => {
    const value = process.env[name];
    if (value) return value;
    if (production) throw new Error(`Missing required environment variable ${name}`);
    return devDefault;
  };

  const resendApiKey = process.env.RESEND_API_KEY ?? '';
  // Printing codes to the server log is only safe on a developer machine, so in production it has to be asked for
  // explicitly (EMAIL_DELIVERY=log, for a demo). Otherwise sign-up is switched off until a provider is configured.
  const emailDelivery: EmailDelivery = resendApiKey
    ? 'resend'
    : !production || process.env.EMAIL_DELIVERY === 'log'
      ? 'log'
      : 'disabled';

  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const clerkSecretKey = process.env.CLERK_SECRET_KEY ?? '';
  const explicitParties = (process.env.CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    databaseUrl: required('DATABASE_URL', DEV_DATABASE_URL),
    jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),
    corsOrigins,
    clinicTimezone: process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata',
    bookingWindowDays: Number(process.env.BOOKING_WINDOW_DAYS ?? 30),
    emailDelivery,
    resendApiKey,
    emailFrom: process.env.EMAIL_FROM ?? 'CareSlot <onboarding@resend.dev>',
    clerk: {
      enabled: Boolean(clerkSecretKey),
      secretKey: clerkSecretKey,
      // Hosting dashboards often store a multi-line PEM with literal \n sequences.
      jwtKey: (process.env.CLERK_JWT_KEY ?? '').replace(/\\n/g, '\n'),
      authorizedParties: explicitParties.length > 0 ? explicitParties : corsOrigins,
    },
  };
}
