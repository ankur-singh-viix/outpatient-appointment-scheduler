import { Logger } from '@nestjs/common';
import { DeliveryError, isRetryable } from '../notifications/delivery-error.js';
import { announceEmailMode, BrevoEmailSender, createEmailSender, DisabledEmailSender, ResendEmailSender } from './email-sender.js';

// Every test here uses a fake fetch: nothing in this file can reach Brevo or send a real email.

const KEY = 'xkeysib-test-secret-key-value';
const FROM = 'CareSlot <no-reply@clinic.example>';
const message = { to: 'patient@example.com', subject: 'Appointment confirmed', text: 'Hi Rahul', html: '<p>Hi Rahul</p>' };

function recordingFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fakeFetch };
}

const thrownBy = async (sender: BrevoEmailSender, input = message): Promise<DeliveryError> => {
  try {
    await sender.send(input);
  } catch (error) {
    return error as DeliveryError;
  }
  throw new Error('expected the sender to throw');
};

describe('BrevoEmailSender', () => {
  it("posts to Brevo's transactional API with the key in the api-key header and returns Brevo's message id", async () => {
    const { calls, fakeFetch } = recordingFetch(201, { messageId: '<202611101200.1234@smtp-relay.mailin.fr>' });

    const result = await new BrevoEmailSender(KEY, FROM, fakeFetch).send(message);

    expect(result).toEqual({ reference: '<202611101200.1234@smtp-relay.mailin.fr>' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ 'api-key': KEY, 'Content-Type': 'application/json' });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      sender: { name: 'CareSlot', email: 'no-reply@clinic.example' },
      to: [{ email: 'patient@example.com' }],
      subject: 'Appointment confirmed',
      textContent: 'Hi Rahul',
      htmlContent: '<p>Hi Rahul</p>',
    });
    expect(JSON.stringify(JSON.parse(calls[0].init.body as string))).not.toContain(KEY); // the key is a header, never in the body
  });

  it('sends plain text alone when there is no HTML version (sign-up codes, invitations)', async () => {
    const { calls, fakeFetch } = recordingFetch(201, { messageId: 'm1' });
    await new BrevoEmailSender(KEY, 'no-reply@clinic.example', fakeFetch).send({ to: 'a@b.com', subject: 'Code', text: '123456' });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sender: { email: 'no-reply@clinic.example' }, to: [{ email: 'a@b.com' }], subject: 'Code', textContent: '123456' });
  });

  it('refuses an invalid recipient before calling Brevo, for good', async () => {
    const { calls, fakeFetch } = recordingFetch(201, {});
    for (const to of ['', 'not-an-address', 'a@b', 'two words@x.com', '<a@b.com>']) {
      const error = await thrownBy(new BrevoEmailSender(KEY, FROM, fakeFetch), { ...message, to });
      expect(error).toBeInstanceOf(DeliveryError);
      expect(error).toMatchObject({ retryable: false, code: 'invalid_recipient' });
    }
    expect(calls).toHaveLength(0);
  });

  it("keeps Brevo's own reason when it rejects a recipient, and does not retry it", async () => {
    const { fakeFetch } = recordingFetch(400, { code: 'invalid_parameter', message: 'valid email is required for to' });
    const error = await thrownBy(new BrevoEmailSender(KEY, FROM, fakeFetch));
    expect(error.message).toBe('Brevo responded with HTTP 400 (invalid_parameter: valid email is required for to)');
    expect(error).toMatchObject({ retryable: false, code: 'invalid_parameter' });
    expect(isRetryable(error)).toBe(false);
  });

  it('does not retry a bad or blocked key, an unverified sender or a forbidden request, and never prints the key', async () => {
    for (const [status, body] of [
      [401, { code: 'unauthorized', message: 'Key not found' }],
      [401, { code: 'unauthorized', message: 'We have detected you are using an unrecognised IP address 203.0.113.9' }],
      [403, { code: 'permission_denied', message: 'Sender is not valid or not verified' }],
    ] as const) {
      const error = await thrownBy(new BrevoEmailSender(KEY, FROM, recordingFetch(status, body).fakeFetch));
      expect(error).toMatchObject({ retryable: false });
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).not.toContain(KEY);
    }
  });

  it('retries a rate limit, a timeout and a Brevo outage', async () => {
    for (const status of [408, 429, 500, 502, 503]) {
      const error = await thrownBy(new BrevoEmailSender(KEY, FROM, recordingFetch(status, { code: 'x', message: 'busy' }).fakeFetch));
      expect(error, `HTTP ${status}`).toMatchObject({ retryable: true });
    }
  });

  it('retries when Brevo cannot be reached at all', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const error = await thrownBy(new BrevoEmailSender(KEY, FROM, down));
    expect(error).toMatchObject({ message: 'Could not reach Brevo.', retryable: true });
  });

  it('copes with an error page instead of JSON', async () => {
    const error = await thrownBy(new BrevoEmailSender(KEY, FROM, recordingFetch(502, '<html>Bad gateway</html>').fakeFetch));
    expect(error.message).toBe('Brevo responded with HTTP 502');
    expect(error.retryable).toBe(true);
  });

  it('will not be built from a sender address that is not an address', () => {
    expect(() => new BrevoEmailSender(KEY, 'CareSlot', fetch)).toThrow(/valid sender/);
  });
});

describe('Resend keeps working beside Brevo', () => {
  it('still sends through Resend, and now includes the HTML version when there is one', async () => {
    const { calls, fakeFetch } = recordingFetch(200, { id: 'em_1' });
    await new ResendEmailSender('re_key', 'a@b.com', fakeFetch).send(message);
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ text: 'Hi Rahul', html: '<p>Hi Rahul</p>' });
  });
});

describe('createEmailSender with Brevo', () => {
  const base = { resendApiKey: '', emailFrom: FROM };

  it('builds the Brevo sender when delivery is brevo', () => {
    expect(createEmailSender({ ...base, emailDelivery: 'brevo', brevoApiKey: KEY })).toBeInstanceOf(BrevoEmailSender);
  });

  it('a missing key in production is a disabled sender that fails once, with the reason and without a key', async () => {
    const sender = createEmailSender({ ...base, emailDelivery: 'disabled', emailProblem: 'BREVO_API_KEY is not set.' });
    expect(sender).toBeInstanceOf(DisabledEmailSender);
    const error = await sender.send(message).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retryable: false, code: 'email_not_configured', message: 'Email is not configured: BREVO_API_KEY is not set.' });
  });
});

describe('announceEmailMode with Brevo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says Brevo is in use, explains a key that cannot be used in development, and never prints a key or an address', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    announceEmailMode({ emailDelivery: 'brevo', emailFrom: FROM, emailProblem: null });
    expect(String(log.mock.calls[0][0])).toBe('Email delivery: Brevo.');
    announceEmailMode({ emailDelivery: 'log', emailFrom: FROM, emailProblem: 'EMAIL_FROM is not set. Use a sender you have verified in Brevo.' });
    expect(String(warn.mock.calls[0][0])).toMatch(/\[DEV ONLY\].*key is set but cannot be used: EMAIL_FROM is not set.*NOT sent/);
    expect([...log.mock.calls, ...warn.mock.calls].flat().join('\n')).not.toMatch(/xkeysib|no-reply@clinic/);
  });
});
