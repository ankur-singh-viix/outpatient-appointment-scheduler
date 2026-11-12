import { loadConfig, parseSender } from './config.js';

const KEYS = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'DATABASE_URL', 'JWT_SECRET', 'RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'EMAIL_DELIVERY'];
const BREVO_KEY = 'xkeysib-test-secret-key-value';
const FROM = 'CareSlot <no-reply@clinic.example>';

describe('choosing Brevo as the email provider', () => {
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

  describe('development', () => {
    it('uses Brevo with a key and a sender', () => {
      process.env.BREVO_API_KEY = BREVO_KEY;
      process.env.EMAIL_FROM = FROM;
      expect(loadConfig()).toMatchObject({ emailDelivery: 'brevo', brevoApiKey: BREVO_KEY, emailFrom: FROM, emailProblem: null });
    });

    it('falls back to the terminal, saying why, when a key is set but there is no usable sender', () => {
      process.env.BREVO_API_KEY = BREVO_KEY;
      expect(loadConfig()).toMatchObject({ emailDelivery: 'log' });
      expect(loadConfig().emailProblem).toMatch(/EMAIL_FROM is not set.*verified in Brevo/);
      process.env.EMAIL_FROM = 'not an address';
      expect(loadConfig().emailProblem).toMatch(/not a valid address/);
      process.env.EMAIL_FROM = 'CareSlot <onboarding@resend.dev>';
      expect(loadConfig()).toMatchObject({ emailDelivery: 'log' });
      expect(loadConfig().emailProblem).toMatch(/Resend's testing sender/);
    });

    it('still prints to the terminal with no key at all', () => {
      expect(loadConfig()).toMatchObject({ emailDelivery: 'log', emailProblem: null });
    });
  });

  describe('which provider when both are set', () => {
    it('prefers Brevo unless EMAIL_PROVIDER says otherwise', () => {
      process.env.BREVO_API_KEY = BREVO_KEY;
      process.env.RESEND_API_KEY = 're_key';
      process.env.EMAIL_FROM = FROM;
      expect(loadConfig().emailDelivery).toBe('brevo');
      process.env.EMAIL_PROVIDER = 'resend';
      expect(loadConfig().emailDelivery).toBe('resend');
      process.env.EMAIL_PROVIDER = 'BREVO';
      expect(loadConfig().emailDelivery).toBe('brevo');
    });

    it('keeps using Resend when only its key is set', () => {
      process.env.RESEND_API_KEY = 're_key';
      expect(loadConfig().emailDelivery).toBe('resend');
    });
  });

  describe('production', () => {
    it('uses Brevo with a key and a sender verified there', () => {
      production();
      process.env.BREVO_API_KEY = BREVO_KEY;
      process.env.EMAIL_FROM = FROM;
      expect(loadConfig()).toMatchObject({ emailDelivery: 'brevo', emailProblem: null });
    });

    it('switches email off when the Brevo key is missing, naming the setting and no value', () => {
      production();
      process.env.EMAIL_PROVIDER = 'brevo';
      process.env.EMAIL_FROM = FROM;
      expect(loadConfig()).toMatchObject({ emailDelivery: 'disabled', emailProblem: 'BREVO_API_KEY is not set.' });
    });

    it('switches email off without a sender, with an invalid sender, or with the Resend testing sender', () => {
      production();
      process.env.BREVO_API_KEY = BREVO_KEY;
      expect(loadConfig()).toMatchObject({ emailDelivery: 'disabled' });
      expect(loadConfig().emailProblem).toMatch(/EMAIL_FROM is not set/);
      for (const from of ['CareSlot', 'a@b', 'CareSlot <>']) {
        process.env.EMAIL_FROM = from;
        expect(loadConfig().emailDelivery, from).toBe('disabled');
      }
      process.env.EMAIL_FROM = 'onboarding@resend.dev';
      expect(loadConfig().emailProblem).toMatch(/Resend's testing sender/);
    });

    it('never puts the key in the reason it gives', () => {
      production();
      process.env.BREVO_API_KEY = BREVO_KEY;
      for (const from of [undefined, 'nonsense', 'onboarding@resend.dev']) {
        if (from) process.env.EMAIL_FROM = from;
        expect(loadConfig().emailProblem).not.toContain(BREVO_KEY);
      }
    });

    it('never prints emails: with no key it is off, not in the terminal', () => {
      production();
      expect(loadConfig()).toMatchObject({ emailDelivery: 'disabled', emailProblem: 'No email provider key is set (BREVO_API_KEY or RESEND_API_KEY).' });
    });
  });
});

describe('parseSender', () => {
  it('reads a name and an address, or a bare address', () => {
    expect(parseSender('CareSlot <no-reply@clinic.example>')).toEqual({ name: 'CareSlot', email: 'no-reply@clinic.example' });
    expect(parseSender('"CareSlot Clinic" <no-reply@clinic.example>')).toEqual({ name: 'CareSlot Clinic', email: 'no-reply@clinic.example' });
    expect(parseSender('  no-reply@clinic.example ')).toEqual({ name: null, email: 'no-reply@clinic.example' });
    expect(parseSender('<no-reply@clinic.example>')).toEqual({ name: null, email: 'no-reply@clinic.example' });
  });

  it('rejects anything that is not an address', () => {
    for (const from of ['', 'CareSlot', 'a@b', '<>', 'CareSlot <a b@c.com>', 'a@@b.com']) expect(parseSender(from), from).toBeNull();
  });
});
