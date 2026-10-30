import { loadConfig } from './config.js';

const KEYS = [
  'NODE_ENV',
  'RAILWAY_ENVIRONMENT_NAME',
  'DATABASE_URL',
  'JWT_SECRET',
  'RESEND_API_KEY',
  'EMAIL_DELIVERY',
  'EMAIL_FROM',
  'CORS_ORIGIN',
  'CLERK_SECRET_KEY',
  'CLERK_JWT_KEY',
  'CLERK_AUTHORIZED_PARTIES',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'PAYMENT_HOLD_MINUTES',
  'REFUND_FULL_HOURS_BEFORE',
  'REFUND_PARTIAL_HOURS_BEFORE',
  'REFUND_PARTIAL_PERCENT',
  'REMINDER_HOURS_BEFORE',
  'BACKGROUND_JOBS',
  'SMS_PROVIDER',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'SMS_DEFAULT_COUNTRY_CODE',
  'NOTIFICATION_MAX_ATTEMPTS',
  'NOTIFICATION_RETRY_BASE_SECONDS',
];

describe('email delivery mode', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const production = () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://x:y@host/db';
    process.env.JWT_SECRET = 'a-real-secret';
  };

  it('logs codes to the server log on a developer machine', () => {
    expect(loadConfig().emailDelivery).toBe('log');
  });

  it('uses Resend whenever an API key is set', () => {
    process.env.RESEND_API_KEY = 're_key';
    expect(loadConfig()).toMatchObject({ emailDelivery: 'resend', resendApiKey: 're_key' });
    production();
    expect(loadConfig().emailDelivery).toBe('resend');
  });

  it('switches sign-up off in production without a provider, rather than printing codes into the logs', () => {
    production();
    expect(loadConfig().emailDelivery).toBe('disabled');
  });

  it('allows log delivery in production only when explicitly requested', () => {
    production();
    process.env.EMAIL_DELIVERY = 'log';
    expect(loadConfig().emailDelivery).toBe('log');
  });

  it('keeps Clerk off unless a secret key is set, so the legacy login works on its own', () => {
    expect(loadConfig().clerk).toMatchObject({ enabled: false, secretKey: '' });
  });

  it('turns Clerk on with a key, and allows tokens only from our frontend origins by default', () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_example';
    process.env.CORS_ORIGIN = 'https://app.example.com, http://localhost:3001';
    expect(loadConfig().clerk).toMatchObject({
      enabled: true,
      authorizedParties: ['https://app.example.com', 'http://localhost:3001'],
    });
    process.env.CLERK_AUTHORIZED_PARTIES = 'https://only-this.example.com';
    expect(loadConfig().clerk.authorizedParties).toEqual(['https://only-this.example.com']);
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CORS_ORIGIN;
    delete process.env.CLERK_AUTHORIZED_PARTIES;
  });

  it('accepts a PEM public key stored with literal \\n sequences', () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_example';
    process.env.CLERK_JWT_KEY = '-----BEGIN PUBLIC KEY-----\\nABC\\n-----END PUBLIC KEY-----';
    expect(loadConfig().clerk.jwtKey).toBe('-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----');
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_JWT_KEY;
  });

  it('treats Railway like production', () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    process.env.DATABASE_URL = 'postgres://x:y@host/db';
    process.env.JWT_SECRET = 'a-real-secret';
    expect(loadConfig().emailDelivery).toBe('disabled');
  });
  describe('payments and reminders', () => {
    it('is off, with a 15 minute hold and the standard refund policy, when nothing is configured', () => {
      const { payments, reminderHoursBefore, backgroundJobs } = loadConfig();
      expect(payments.enabled).toBe(false);
      expect(payments.holdMinutes).toBe(15);
      expect(payments.refundPolicy).toEqual({ fullRefundHoursBefore: 24, partialRefundHoursBefore: 2, partialRefundPercent: 50 });
      expect(reminderHoursBefore).toEqual([24, 1]);
      expect(backgroundJobs).toBe(true);
    });

    it('needs BOTH Razorpay keys, and never reports a key as enabled with only one', () => {
      process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
      expect(loadConfig().payments.enabled).toBe(false);
      process.env.RAZORPAY_KEY_SECRET = 'secret';
      expect(loadConfig().payments).toMatchObject({ enabled: true, keyId: 'rzp_test_x' });
      process.env.RAZORPAY_KEY_ID = '   ';
      expect(loadConfig().payments.enabled).toBe(false);
    });

    it('reads the hold, refund policy and reminders from the environment, ignoring nonsense', () => {
      process.env.PAYMENT_HOLD_MINUTES = '30';
      process.env.REFUND_FULL_HOURS_BEFORE = '48';
      process.env.REFUND_PARTIAL_HOURS_BEFORE = '6';
      process.env.REFUND_PARTIAL_PERCENT = '25';
      process.env.REMINDER_HOURS_BEFORE = '48, 1 ,x,-3,0';
      process.env.BACKGROUND_JOBS = 'false';
      const { payments, reminderHoursBefore, backgroundJobs } = loadConfig();
      expect(payments.holdMinutes).toBe(30);
      expect(payments.refundPolicy).toEqual({ fullRefundHoursBefore: 48, partialRefundHoursBefore: 6, partialRefundPercent: 25 });
      expect(reminderHoursBefore).toEqual([48, 1]);
      expect(backgroundJobs).toBe(false);

      process.env.PAYMENT_HOLD_MINUTES = 'soon';
      process.env.REFUND_PARTIAL_PERCENT = '250';
      process.env.REMINDER_HOURS_BEFORE = '';
      const fallback = loadConfig();
      expect(fallback.payments.holdMinutes).toBe(15);
      expect(fallback.payments.refundPolicy.partialRefundPercent).toBe(100); // a share can never exceed the whole
      expect(fallback.reminderHoursBefore).toEqual([]); // empty switches reminders off
    });
  });
});

describe('SMS and notification delivery settings', () => {
  const clear = () => {
    for (const key of ['SMS_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'SMS_DEFAULT_COUNTRY_CODE', 'NOTIFICATION_MAX_ATTEMPTS', 'NOTIFICATION_RETRY_BASE_SECONDS']) delete process.env[key];
  };

  it('has SMS off, and 5 attempts starting at a minute, when nothing is configured', () => {
    clear();
    const { sms, notifications } = loadConfig();
    expect(sms.provider).toBe('disabled');
    expect(notifications).toEqual({ maxAttempts: 5, retryBaseSeconds: 60 });
  });

  it('turns Twilio on only when all three of its settings are present', () => {
    clear();
    process.env.TWILIO_ACCOUNT_SID = 'ACx';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    expect(loadConfig().sms.provider).toBe('disabled');
    process.env.TWILIO_FROM_NUMBER = '+15005550006';
    expect(loadConfig().sms).toMatchObject({ provider: 'twilio', twilioAccountSid: 'ACx', fromNumber: '+15005550006' });
    process.env.TWILIO_AUTH_TOKEN = '   ';
    expect(loadConfig().sms.provider).toBe('disabled');
    clear();
  });

  it('lets SMS_PROVIDER force the mock for development, or force SMS off even with credentials', () => {
    clear();
    process.env.SMS_PROVIDER = 'mock';
    expect(loadConfig().sms.provider).toBe('mock');
    process.env.SMS_PROVIDER = 'Disabled';
    process.env.TWILIO_ACCOUNT_SID = 'ACx';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_FROM_NUMBER = '+15005550006';
    expect(loadConfig().sms.provider).toBe('disabled');
    process.env.SMS_PROVIDER = 'carrier-pigeon';
    expect(loadConfig().sms.provider).toBe('twilio'); // an unknown name is ignored: credentials decide
    clear();
  });

  it('reads the retry settings and the default country code, ignoring nonsense', () => {
    clear();
    process.env.NOTIFICATION_MAX_ATTEMPTS = '8';
    process.env.NOTIFICATION_RETRY_BASE_SECONDS = '30';
    process.env.SMS_DEFAULT_COUNTRY_CODE = ' +91 ';
    const config = loadConfig();
    expect(config.notifications).toEqual({ maxAttempts: 8, retryBaseSeconds: 30 });
    expect(config.sms.defaultCountryCode).toBe('+91');
    process.env.NOTIFICATION_MAX_ATTEMPTS = '0';
    process.env.NOTIFICATION_RETRY_BASE_SECONDS = 'soon';
    expect(loadConfig().notifications).toEqual({ maxAttempts: 1, retryBaseSeconds: 60 });
    clear();
  });
});
