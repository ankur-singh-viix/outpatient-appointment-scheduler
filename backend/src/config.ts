import { existsSync } from 'node:fs';

export interface AppConfig {
  databaseUrl: string;
  jwtSecret: string;
  corsOrigins: string[];
  /** The website's address, for links in emails (invitations). FRONTEND_URL, or the first CORS origin. */
  frontendUrl: string;
  /** IANA zone of the clinics; decides what "today" and "now" mean for slots. */
  clinicTimezone: string;
  /** How many days ahead patients may book. */
  bookingWindowDays: number;
  /**
   * How emails (sign-up codes, invitations, booking notices) are delivered, chosen from NODE_ENV:
   * - development and tests: Brevo (BREVO_API_KEY) or Resend (RESEND_API_KEY) when a key is set, otherwise the terminal ("log"),
   *   which sends nothing. EMAIL_PROVIDER=brevo|resend picks one when both keys are present; otherwise Brevo is used;
   * - production: the provider, only with its key and an EMAIL_FROM on a sender or domain verified there, otherwise "disabled".
   */
  emailDelivery: EmailDelivery;
  /** Why email is "disabled" (or, in development, falls back to the terminal) when a key is set. Never contains the key. Otherwise null. */
  emailProblem: string | null;
  resendApiKey: string;
  brevoApiKey: string;
  /** The "from" address; it must be a sender (Brevo) or on a domain (Resend) you have verified with the provider. */
  emailFrom: string;
  clerk: ClerkConfig;
  payments: PaymentsConfig;
  sms: SmsConfig;
  notifications: NotificationDeliveryConfig;
  /** How many hours before an appointment a reminder email goes out (one email per entry). Empty turns reminders off. */
  reminderHoursBefore: number[];
  /**
   * Minimum notice for schedule changes (SCHEDULE_CHANGE_MIN_NOTICE_HOURS, default 2, 0 turns it off): a change that would affect an
   * appointment less than this many hours away, or already under way, is refused. Counted in the clinic's time zone.
   */
  scheduleChangeNoticeHours: number;
  /** Hours between contacts with a patient who has not chosen a new time (SCHEDULE_REMINDER_COOLDOWN_HOURS, default 24): the first message, then at most two reminders. */
  scheduleReminderCooldownHours: number;
  /** Runs the background workers (expiring unpaid holds, sending due emails, settling refunds). Off in tests that call them directly. */
  backgroundJobs: boolean;
  assistant: AssistantConfig;
}

/** The AI assistant (Google Gemini over plain HTTPS). It is off, with a clear message, until GEMINI_API_KEY is set. */
export interface AssistantConfig {
  geminiApiKey: string;
  /** A low-cost Gemini Flash model; change it with GEMINI_MODEL. */
  geminiModel: string;
  /** Override only to point at a stand-in server in tests (GEMINI_BASE_URL). */
  geminiBaseUrl: string;
  /** The longest answer the model may write (ASSISTANT_MAX_OUTPUT_TOKENS). */
  maxOutputTokens: number;
  /** How long to wait for the model before giving up (ASSISTANT_TIMEOUT_SECONDS). */
  timeoutMs: number;
  /** Messages one user may send per window (ASSISTANT_RATE_LIMIT per ASSISTANT_RATE_WINDOW_MINUTES). */
  rateLimit: number;
  rateWindowMinutes: number;
  /** How long a prepared booking, move or cancellation waits for the patient to press Confirm (ASSISTANT_CONFIRMATION_MINUTES). */
  confirmationMinutes: number;
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

export type EmailDelivery = 'brevo' | 'resend' | 'log' | 'disabled';

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

/** True for Resend's shared testing sender (onboarding@resend.dev): it only delivers to the Resend account owner's own address. */
export function usesResendTestingSender(from: string): boolean {
  return /@resend\.dev>?\s*$/i.test(from.trim());
}

/** The address part of an EMAIL_FROM such as `CareSlot <no-reply@clinic.example>` or `no-reply@clinic.example`, or null when it is not one. */
export function parseSender(from: string): { name: string | null; email: string } | null {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>\s*$/.exec(from) ?? /^\s*()([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*$/.exec(from);
  return match ? { name: match[1]?.trim() || null, email: match[2] } : null;
}

/**
 * The one place that decides how email is delivered. Production never prints emails (an invitation link or sign-up code in a log
 * is a credential) and never uses a shared testing sender (it cannot reach real recipients), so without a key and a verified
 * sender it is switched off, with a reason that is safe to show. Anywhere else, no key means the terminal, which is for
 * development only; a key without a usable sender also falls back to the terminal there, with the reason.
 *
 * Which provider: EMAIL_PROVIDER=brevo|resend when set; otherwise Brevo if BREVO_API_KEY is set, else Resend if RESEND_API_KEY is.
 */
function chooseEmailDelivery(args: {
  production: boolean;
  resendKey: boolean;
  brevoKey: boolean;
  explicitFrom: string;
  provider: string;
}): { delivery: EmailDelivery; problem: string | null } {
  const requested = args.provider === 'brevo' || args.provider === 'resend' ? args.provider : null;
  const provider = requested ?? (args.brevoKey ? 'brevo' : args.resendKey ? 'resend' : null);
  const label = provider === 'brevo' ? 'Brevo' : 'Resend';
  const keyName = provider === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY';
  const hasKey = provider === 'brevo' ? args.brevoKey : provider === 'resend' ? args.resendKey : false;
  const fallback = (problem: string): { delivery: EmailDelivery; problem: string } => ({ delivery: args.production ? 'disabled' : 'log', problem });

  if (!provider || !hasKey) {
    if (!args.production) return { delivery: 'log', problem: null };
    return { delivery: 'disabled', problem: provider ? `${keyName} is not set.` : 'No email provider key is set (BREVO_API_KEY or RESEND_API_KEY).' };
  }
  if (provider === 'resend') {
    if (!args.production) return { delivery: 'resend', problem: null };
    if (!args.explicitFrom) return { delivery: 'disabled', problem: 'EMAIL_FROM is not set. Use an address on a domain you have verified in Resend.' };
    if (usesResendTestingSender(args.explicitFrom)) {
      return { delivery: 'disabled', problem: 'EMAIL_FROM uses Resend\'s testing sender (resend.dev), which cannot email real recipients. Use an address on a domain you have verified in Resend.' };
    }
    return { delivery: 'resend', problem: null };
  }
  // Brevo only sends from a sender you have verified in its dashboard, so an explicit, well-formed EMAIL_FROM is always required.
  if (!args.explicitFrom) return fallback(`EMAIL_FROM is not set. Use a sender you have verified in ${label} (Senders, Domains & Dedicated IPs).`);
  if (!parseSender(args.explicitFrom)) return fallback('EMAIL_FROM is not a valid address. Use NAME <address@your-domain> or address@your-domain.');
  if (usesResendTestingSender(args.explicitFrom)) return fallback(`EMAIL_FROM is Resend's testing sender, which ${label} cannot send from. Use a sender you have verified in ${label}.`);
  return { delivery: 'brevo', problem: null };
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
  const brevoApiKey = (process.env.BREVO_API_KEY ?? '').trim();
  const emailFrom = process.env.EMAIL_FROM ?? 'CareSlot <onboarding@resend.dev>';
  const { delivery: emailDelivery, problem: emailProblem } = chooseEmailDelivery({
    production,
    resendKey: resendApiKey.trim().length > 0,
    brevoKey: brevoApiKey.length > 0,
    explicitFrom: (process.env.EMAIL_FROM ?? '').trim(),
    provider: (process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase(),
  });

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
    frontendUrl: (process.env.FRONTEND_URL ?? corsOrigins[0] ?? 'http://localhost:3001').trim().replace(/\/+$/, ''),
    clinicTimezone: process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata',
    bookingWindowDays: Number(process.env.BOOKING_WINDOW_DAYS ?? 30),
    emailDelivery,
    emailProblem,
    resendApiKey,
    brevoApiKey,
    emailFrom,
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
    assistant: {
      geminiApiKey: (process.env.GEMINI_API_KEY ?? '').trim(),
      geminiModel: (process.env.GEMINI_MODEL ?? '').trim() || 'gemini-3.5-flash-lite',
      geminiBaseUrl: ((process.env.GEMINI_BASE_URL ?? '').trim() || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
      maxOutputTokens: Math.max(64, Math.min(4096, Math.floor(numberFrom('ASSISTANT_MAX_OUTPUT_TOKENS', 800)))),
      timeoutMs: Math.max(1, Math.min(120, numberFrom('ASSISTANT_TIMEOUT_SECONDS', 30))) * 1000,
      rateLimit: Math.max(1, Math.floor(numberFrom('ASSISTANT_RATE_LIMIT', 20))),
      rateWindowMinutes: Math.max(1, Math.floor(numberFrom('ASSISTANT_RATE_WINDOW_MINUTES', 10))),
      confirmationMinutes: Math.max(1, Math.min(60, Math.floor(numberFrom('ASSISTANT_CONFIRMATION_MINUTES', 5)))),
    },
    scheduleChangeNoticeHours: Math.min(numberFrom('SCHEDULE_CHANGE_MIN_NOTICE_HOURS', 2), 72),
    scheduleReminderCooldownHours: Math.min(numberFrom('SCHEDULE_REMINDER_COOLDOWN_HOURS', 24), 168),
  };
}
