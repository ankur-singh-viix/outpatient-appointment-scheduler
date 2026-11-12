import { Logger } from '@nestjs/common';
import { DeliveryError, isRetryable } from '../notifications/delivery-error.js';
import { announceEmailMode, createEmailSender, DisabledEmailSender, LogEmailSender, ResendEmailSender } from './email-sender.js';

const message = { to: 'a@b.com', subject: 'Your code', text: 'Code 123456' };

describe('ResendEmailSender', () => {
  it('posts the message to the Resend API with the API key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await new ResendEmailSender('re_key', 'CareSlot <no-reply@example.com>', fakeFetch).send(message);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer re_key');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: 'CareSlot <no-reply@example.com>',
      to: ['a@b.com'],
      subject: 'Your code',
      text: 'Code 123456',
    });
  });

  it('throws without leaking the API key when the provider rejects the request', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const sender = new ResendEmailSender('re_secret_key', 'x@y.com', fakeFetch);
    await expect(sender.send(message)).rejects.toThrow('HTTP 401');
    await expect(sender.send(message)).rejects.not.toThrow(/re_secret_key/);
  });
});

describe('ResendEmailSender errors', () => {
  const failing = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  /** The error the sender throws (the test fails if it does not throw). */
  const thrownBy = async (sender: ResendEmailSender): Promise<DeliveryError> => {
    try {
      await sender.send(message);
    } catch (error) {
      return error as DeliveryError;
    }
    throw new Error('expected the sender to throw');
  };
  const failure = (status: number, body: unknown) => thrownBy(new ResendEmailSender('re_secret_key', 'x@y.com', failing(status, body)));

  it("shows Resend's own reason for a 403, instead of a bare status code", async () => {
    const error = await failure(403, { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address.' });
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.message).toContain('HTTP 403');
    expect(error.message).toContain('validation_error');
    expect(error.message).toContain('only send testing emails to your own email address');
    expect(error.code).toBe('validation_error');
    expect(error.message).not.toContain('re_secret_key');
  });

  it('treats a refusal (400, 401, 403, 422) as permanent and an outage or rate limit as temporary', async () => {
    for (const status of [400, 401, 403, 422]) expect((await failure(status, { name: 'x', message: 'y' })).retryable).toBe(false);
    for (const status of [429, 500, 503]) expect((await failure(status, { name: 'x', message: 'y' })).retryable).toBe(true);
  });

  it('copes with an error body that is not JSON', async () => {
    const html = (async () => new Response('<html>Bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const error = await thrownBy(new ResendEmailSender('re_k', 'x@y.com', html));
    expect(error.message).toBe('Resend responded with HTTP 502');
    expect(error.retryable).toBe(true);
  });

  it('treats an unreachable Resend as temporary', async () => {
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const error = await thrownBy(new ResendEmailSender('re_k', 'x@y.com', down));
    expect(error.retryable).toBe(true);
  });

  it("returns Resend's email id as the reference", async () => {
    const ok = (async () => new Response(JSON.stringify({ id: 'em_123' }), { status: 200 })) as unknown as typeof fetch;
    expect(await new ResendEmailSender('re_k', 'x@y.com', ok).send(message)).toEqual({ reference: 'em_123' });
  });
});

describe('createEmailSender', () => {
  const base = { resendApiKey: '', emailFrom: 'x@y.com' };

  it('picks the sender that matches the configured delivery mode', () => {
    expect(createEmailSender({ ...base, emailDelivery: 'resend', resendApiKey: 'k' })).toBeInstanceOf(ResendEmailSender);
    expect(createEmailSender({ ...base, emailDelivery: 'log' })).toBeInstanceOf(LogEmailSender);
    expect(createEmailSender({ ...base, emailDelivery: 'disabled' })).toBeInstanceOf(DisabledEmailSender);
  });

  it('a disabled sender refuses to send', async () => {
    await expect(new DisabledEmailSender().send()).rejects.toThrow(/not configured/);
  });

  it('a disabled sender fails for good, with the reason, so the outbox does not keep retrying', async () => {
    const sender = createEmailSender({ ...base, emailDelivery: 'disabled', emailProblem: 'RESEND_API_KEY is not set.' });
    const error = await sender.send(message).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error).toMatchObject({ retryable: false, code: 'email_not_configured', message: 'Email is not configured: RESEND_API_KEY is not set.' });
    expect(isRetryable(error)).toBe(false);
  });
});

describe('LogEmailSender (development only)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the message marked [DEV ONLY] and says plainly that nothing was sent', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const result = await new LogEmailSender().send({ to: 'a@b.com', subject: 'Invitation', text: 'Open https://site.example/invite?token=abc' });
    expect(result).toEqual({ mode: 'dev-log' }); // so callers can tell it from a real send
    expect(String(log.mock.calls[0][0])).toMatch(/^\[DEV ONLY\] NOT sent by email\./);
    expect(String(log.mock.calls[0][0])).toContain('https://site.example/invite?token=abc'); // the link is the point, in development
  });
});

describe('announceEmailMode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says which mode is active, marks development, and never prints a key or an address', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    announceEmailMode({ emailDelivery: 'log', emailFrom: 'CareSlot <a@clinic.example>', emailProblem: null });
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[DEV ONLY\].*NOT sent/);

    announceEmailMode({ emailDelivery: 'resend', emailFrom: 'CareSlot <onboarding@resend.dev>', emailProblem: null });
    expect(String(log.mock.calls[0][0])).toMatch(/testing sender/);
    announceEmailMode({ emailDelivery: 'resend', emailFrom: 'CareSlot <a@clinic.example>', emailProblem: null });
    expect(String(log.mock.calls[1][0])).toBe('Email delivery: Resend.');

    announceEmailMode({ emailDelivery: 'disabled', emailFrom: 'x', emailProblem: 'RESEND_API_KEY is not set.' });
    expect(String(error.mock.calls[0][0])).toMatch(/Email delivery is OFF: RESEND_API_KEY is not set\./);
    const everything = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join('\n');
    expect(everything).not.toMatch(/a@clinic\.example|re_/);
  });
});
