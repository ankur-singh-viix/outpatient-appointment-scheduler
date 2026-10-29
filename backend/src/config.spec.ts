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
});
