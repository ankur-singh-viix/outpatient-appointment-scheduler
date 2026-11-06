import { DeliveryError } from './delivery-error.js';
import { DisabledSmsProvider, MockSmsProvider, TwilioSmsProvider, createSmsProvider, normalisePhone } from './sms-provider.js';

const config = { twilioAccountSid: 'ACtest0123456789', twilioAuthToken: 'super_secret_token', fromNumber: '+15005550006' };

function fakeFetch(status: number, json: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('normalisePhone', () => {
  it('keeps a number that already has a country code, removing spaces and punctuation', () => {
    expect(normalisePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalisePhone('+1 (415) 555-0132')).toBe('+14155550132');
    expect(normalisePhone('  +44.7700.900123 ')).toBe('+447700900123');
  });

  it('turns a 00 prefix into +', () => {
    expect(normalisePhone('0091 98765 43210')).toBe('+919876543210');
  });

  it('completes a number without a country code only when a default is configured, and otherwise skips it rather than guess', () => {
    expect(normalisePhone('98765 43210')).toBeNull();
    expect(normalisePhone('98765 43210', '+91')).toBe('+919876543210');
    expect(normalisePhone('098765 43210', '+91')).toBe('+919876543210');
    expect(normalisePhone('98765 43210', '91')).toBeNull(); // a malformed default is ignored
  });

  it('rejects anything that cannot be a phone number', () => {
    for (const bad of [null, undefined, '', '   ', 'call me', '+', '+12', '+0123456789', '+1234567890123456', '12ab34', '+91 98765 4321x']) {
      expect(normalisePhone(bad as string | null | undefined, '+91')).toBeNull();
    }
  });
});

describe('TwilioSmsProvider', () => {
  it('posts the text to the Messages API with Basic auth, and returns the message SID as the reference', async () => {
    const { impl, calls } = fakeFetch(201, { sid: 'SM123', status: 'queued' });
    const result = await new TwilioSmsProvider(config, impl).send({ to: '+919876543210', body: 'CareSlot: hello' });
    expect(result).toEqual({ reference: 'SM123' });
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest0123456789/Messages.json');
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('ACtest0123456789:super_secret_token').toString('base64')}`);
    expect(new URLSearchParams(calls[0].body).get('To')).toBe('+919876543210');
    expect(new URLSearchParams(calls[0].body).get('From')).toBe('+15005550006');
    expect(new URLSearchParams(calls[0].body).get('Body')).toBe('CareSlot: hello');
    expect(calls[0].body).not.toContain('super_secret_token'); // credentials go in the header, never the body
  });

  it('treats a refusal such as an invalid number as permanent, with the provider code, and never leaks the credentials', async () => {
    const { impl } = fakeFetch(400, { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 });
    const error = await new TwilioSmsProvider(config, impl).send({ to: '+1', body: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryError);
    expect((error as DeliveryError).retryable).toBe(false);
    expect((error as DeliveryError).code).toBe('21211');
    expect((error as DeliveryError).message).toContain('HTTP 400');
    expect((error as DeliveryError).message).toContain('not a valid phone number');
    expect((error as DeliveryError).message).not.toMatch(/super_secret_token|ACtest/);
  });

  it.each([429, 500, 502, 503])('treats HTTP %i as temporary, worth retrying', async (status) => {
    const { impl } = fakeFetch(status, { message: 'busy' });
    const error = await new TwilioSmsProvider(config, impl).send({ to: '+919876543210', body: 'x' }).catch((e: unknown) => e);
    expect((error as DeliveryError).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404])('treats HTTP %i as permanent', async (status) => {
    const { impl } = fakeFetch(status, { message: 'no' });
    const error = await new TwilioSmsProvider(config, impl).send({ to: '+919876543210', body: 'x' }).catch((e: unknown) => e);
    expect((error as DeliveryError).retryable).toBe(false);
  });

  it('treats an unreachable provider as temporary', async () => {
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const error = await new TwilioSmsProvider(config, down).send({ to: '+919876543210', body: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryError);
    expect((error as DeliveryError).retryable).toBe(true);
  });
});

describe('MockSmsProvider', () => {
  it('records what it is asked to send and returns a reference', async () => {
    const mock = new MockSmsProvider();
    expect(await mock.send({ to: '+919876543210', body: 'hi' })).toEqual({ reference: 'mock-sms-1' });
    expect(mock.sent).toEqual([{ to: '+919876543210', body: 'hi', reference: 'mock-sms-1' }]);
  });

  it('can be made to fail a number of times, then recover', async () => {
    const mock = new MockSmsProvider();
    mock.failWith = new DeliveryError('provider down', true);
    mock.failTimes = 2;
    await expect(mock.send({ to: '+919876543210', body: 'a' })).rejects.toThrow('provider down');
    await expect(mock.send({ to: '+919876543210', body: 'a' })).rejects.toThrow('provider down');
    await expect(mock.send({ to: '+919876543210', body: 'a' })).resolves.toEqual({ reference: 'mock-sms-1' });
  });
});

describe('createSmsProvider', () => {
  const base = { twilioAccountSid: '', twilioAuthToken: '', fromNumber: '', defaultCountryCode: '' };

  it('is off without credentials: not enabled, and a stray send fails permanently with a clear message', async () => {
    const provider = createSmsProvider({ ...base, provider: 'disabled' });
    expect(provider).toBeInstanceOf(DisabledSmsProvider);
    expect(provider.enabled).toBe(false);
    const error = await provider.send({ to: '+919876543210', body: 'x' }).catch((e: unknown) => e);
    expect((error as DeliveryError).retryable).toBe(false);
    expect((error as DeliveryError).message).toMatch(/not configured/i);
  });

  it('is Twilio when configured, and the mock only when asked for', () => {
    expect(createSmsProvider({ ...base, ...config, provider: 'twilio' })).toBeInstanceOf(TwilioSmsProvider);
    expect(createSmsProvider({ ...base, provider: 'mock' })).toBeInstanceOf(MockSmsProvider);
  });
});
