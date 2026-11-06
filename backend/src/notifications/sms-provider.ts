import { Logger } from '@nestjs/common';
import type { SmsConfig } from '../config.js';
import { DeliveryError, isRetryableStatus, type SendResult } from './delivery-error.js';

export interface SmsMessage {
  /** The recipient in international format, e.g. +919876543210. */
  to: string;
  body: string;
}

/**
 * Anything that can send a text message. Twilio is the real adapter; the mock one is for development and tests. To add another
 * provider (MSG91, SNS...), implement this and return it from `createSmsProvider`.
 */
export interface SmsProvider {
  readonly name: string;
  /** False when no credentials are configured: nothing is queued for SMS at all, and nothing fails. */
  readonly enabled: boolean;
  /** Throws a DeliveryError when the text was not accepted. */
  send(message: SmsMessage): Promise<SendResult>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/**
 * A phone number in international format (+ and 8 to 15 digits), or null when it cannot be made into one. Numbers saved without a
 * country code are completed with `defaultCountryCode` when one is configured, and are otherwise not texted: guessing a country
 * could text a stranger.
 */
export function normalisePhone(raw: string | null | undefined, defaultCountryCode = ''): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/[\s().-]/g, '');
  let candidate: string;
  if (cleaned.startsWith('+')) candidate = cleaned;
  else if (cleaned.startsWith('00')) candidate = `+${cleaned.slice(2)}`;
  else if (defaultCountryCode && /^\+\d{1,3}$/.test(defaultCountryCode) && /^\d{6,12}$/.test(cleaned)) candidate = `${defaultCountryCode}${cleaned.replace(/^0+/, '')}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

/** Twilio's Programmable Messaging REST API (https://www.twilio.com/docs/messaging/api). No extra package. */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  readonly enabled = true;

  constructor(
    private readonly config: Pick<SmsConfig, 'twilioAccountSid' | 'twilioAuthToken' | 'fromNumber'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: SmsMessage): Promise<SendResult> {
    const { twilioAccountSid: sid, twilioAuthToken: token, fromNumber } = this.config;
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: message.to, From: fromNumber, Body: message.body }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DeliveryError('Could not reach Twilio.', true);
    }
    // Twilio explains a refusal as { code, message, status }. Its text never contains the credentials.
    const body = (await response.json().catch(() => null)) as { sid?: string; code?: number; message?: string } | null;
    if (!response.ok) {
      const detail = [body?.code, body?.message].filter(Boolean).join(': ').slice(0, 300);
      throw new DeliveryError(`Twilio responded with HTTP ${response.status}${detail ? ` (${detail})` : ''}`, isRetryableStatus(response.status), body?.code ? String(body.code) : undefined);
    }
    return { reference: body?.sid };
  }
}

/**
 * A stand-in that sends nothing: it records each text (and writes it to the server log), and can be told to fail. For
 * development (SMS_PROVIDER=mock) and for automated tests. It is never chosen unless asked for.
 */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';
  readonly enabled = true;
  readonly sent: (SmsMessage & { reference: string })[] = [];
  /** When set, the next sends fail with this error (cleared after `failTimes` failures, or never if undefined). */
  failWith: DeliveryError | null = null;
  failTimes = Number.POSITIVE_INFINITY;
  private readonly logger = new Logger('DevSms');

  async send(message: SmsMessage): Promise<SendResult> {
    if (this.failWith && this.failTimes > 0) {
      this.failTimes -= 1;
      throw this.failWith;
    }
    const reference = `mock-sms-${this.sent.length + 1}`;
    this.sent.push({ ...message, reference });
    this.logger.log(`To: ${message.to} | ${message.body}`);
    return { reference };
  }
}

/** Used when SMS has no credentials: it is not enabled, so no text is ever queued, and a stray send fails permanently and clearly. */
export class DisabledSmsProvider implements SmsProvider {
  readonly name = 'disabled';
  readonly enabled = false;
  async send(): Promise<SendResult> {
    throw new DeliveryError('SMS is not configured (set the Twilio credentials, or SMS_PROVIDER=mock for development).', false, 'sms-not-configured');
  }
}

export function createSmsProvider(config: SmsConfig): SmsProvider {
  if (config.provider === 'twilio') return new TwilioSmsProvider(config);
  if (config.provider === 'mock') return new MockSmsProvider();
  return new DisabledSmsProvider();
}
