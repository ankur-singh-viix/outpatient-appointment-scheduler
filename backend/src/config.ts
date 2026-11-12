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
  payments: PaymentsConfig;
  sms: SmsConfig;
  notifications: NotificationDeliveryConfig;
  /** How many hours before an appointment a reminder email goes out (one email per entry). Empty turns reminders off. */
  reminderHoursBefore: number[];
  /** Runs the background workers (expiring unpaid holds, sending due emails, settling refunds). Off in tests that call them directly. */
  backgroundJobs: boolean;
}

export type SmsProviderName = 'twilio' | 'mock' | 'disabled';

/** Text messages. Off unless the provider's credentials are set (or SMS_PROVIDER=mock for a development stand-in). */
export interface SmsConfig {
  provider: SmsProviderName;
  twilioAccountSid: string;
  twilioAuthToken: string;
  /** The sending number or messaging-service sender id registered with the provider. */
  fromNumber: string;
  /** Country calling code prepended to numbers saved without one, e.g. "+91". Empty: such numbers are not texted. */
  defaultCountryCode: string;
}

/** How hard the outbox tries to deliver a message before giving up and keeping it as FAILED for follow-up. */
export interface NotificationDeliveryConfig {
  maxAttempts: number;
  /** The wait after the first failure; it doubles after each further one, up to an hour. */
  retryBaseSeconds: number;
}

/** Razorpay (card/UPI payments). Off unless both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set: booking is then free, as before. */
export interface PaymentsConfig {
  enabled: boolean;
  keyId: string;
  keySecret: string;
  /** Signs webhook calls from Razorpay. Without it the webhook endpoint refuses everything. */
  webhookSecret: string;
  /** How long an unpaid booking holds its slot before the slot is released. */
  holdMinutes: number;
  refundPolicy: RefundPolicy;
}

/** Patient cancellations: full refund this many hours or more before the appointment, a partial one later, none after. */
export interface RefundPolicy {
  fullRefundHoursBefore: number;
  partialRefundHoursBefore: number;
  partialRefundPercent: number;
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
  const razorpayKeyId = (process.env.RAZORPAY_KEY_ID ?? '').trim();
  const razorpayKeySecret = (process.env.RAZORPAY_KEY_SECRET ?? '').trim();
  /** A non-negative number from the environment, or the default when it is unset or not a number. */
  const numberFrom = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return process.env[name] && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const reminderHours = process.env.REMINDER_HOURS_BEFORE ?? '24,1';
  const twilioAccountSid = (process.env.TWILIO_ACCOUNT_SID ?? '').trim();
  const twilioAuthToken = (process.env.TWILIO_AUTH_TOKEN ?? '').trim();
  const twilioFrom = (process.env.TWILIO_FROM_NUMBER ?? '').trim();
  // An explicit SMS_PROVIDER wins; otherwise Twilio is used exactly when all three of its settings are present.
  const requestedSms = (process.env.SMS_PROVIDER ?? '').trim().toLowerCase();
  const smsProvider: SmsProviderName =
    requestedSms === 'mock' ? 'mock' : requestedSms === 'disabled' ? 'disabled' : twilioAccountSid && twilioAuthToken && twilioFrom ? 'twilio' : 'disabled';
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
    payments: {
      enabled: Boolean(razorpayKeyId && razorpayKeySecret),
      keyId: razorpayKeyId,
      keySecret: razorpayKeySecret,
      webhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET ?? '').trim(),
      holdMinutes: Math.max(1, numberFrom('PAYMENT_HOLD_MINUTES', 15)),
      refundPolicy: {
        fullRefundHoursBefore: numberFrom('REFUND_FULL_HOURS_BEFORE', 24),
        partialRefundHoursBefore: numberFrom('REFUND_PARTIAL_HOURS_BEFORE', 2),
        partialRefundPercent: Math.min(100, numberFrom('REFUND_PARTIAL_PERCENT', 50)),
      },
    },
    sms: {
      provider: smsProvider,
      twilioAccountSid,
      twilioAuthToken,
      fromNumber: twilioFrom,
      defaultCountryCode: (process.env.SMS_DEFAULT_COUNTRY_CODE ?? '').trim(),
    },
    notifications: {
      maxAttempts: Math.max(1, Math.floor(numberFrom('NOTIFICATION_MAX_ATTEMPTS', 5))),
      retryBaseSeconds: Math.max(1, numberFrom('NOTIFICATION_RETRY_BASE_SECONDS', 60)),
    },
    reminderHoursBefore: reminderHours
      .split(',')
      .map((hours) => Number(hours.trim()))
      .filter((hours) => Number.isFinite(hours) && hours > 0),
    backgroundJobs: process.env.BACKGROUND_JOBS !== 'false',
  };
}
