import { createEmailSender, DisabledEmailSender, LogEmailSender, ResendEmailSender } from './email-sender.js';

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
});
