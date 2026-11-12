import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { DeliveryError, isRetryableStatus, type SendResult } from '../notifications/delivery-error.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Anything that can deliver an email. Swapped for a recording fake in tests. */
export interface EmailSender {
  /** Throws when the email was not sent (a DeliveryError says whether trying again is worthwhile). */
  send(message: EmailMessage): Promise<SendResult | void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * Development only: prints the email to the server log instead of sending it, so sign-up can be tried locally
 * without an email provider. It exposes the verification code to anyone who can read the log, so it is never
 * the default in production (see `emailDelivery` in config.ts).
 */
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger('DevEmail');

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(`To: ${message.to} | ${message.subject}\n${message.text}`);
  }
}

/** Sends through Resend's HTTPS API (https://resend.com). Needs RESEND_API_KEY; no extra package. */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DeliveryError('Could not reach Resend.', true);
    }
    // Resend explains a refusal in the body ({ statusCode, name, message }); a bare "HTTP 403" hides the actual reason.
    const body = (await response.json().catch(() => null)) as { id?: string; name?: string; message?: string } | null;
    if (!response.ok) {
      const reason = [body?.name, body?.message].filter(Boolean).join(': ').slice(0, 300);
      throw new DeliveryError(`Resend responded with HTTP ${response.status}${reason ? ` (${reason})` : ''}`, isRetryableStatus(response.status), body?.name);
    }
    return { reference: body?.id };
  }
}

/** Used when no provider is configured in production: sign-up is refused before this is ever called. */
export class DisabledEmailSender implements EmailSender {
  async send(): Promise<void> {
    throw new Error('Email delivery is not configured.');
  }
}

export function createEmailSender(config: Pick<AppConfig, 'emailDelivery' | 'resendApiKey' | 'emailFrom'>): EmailSender {
  if (config.emailDelivery === 'resend') {
    // The most common cause of Resend answering 403: mail from its shared test address (onboarding@resend.dev) can only go to
    // the Resend account owner's own email, and any other sender address needs a verified domain.
    if (/@resend\.dev>?\s*$/i.test(config.emailFrom)) {
      new Logger('Email').warn('EMAIL_FROM uses resend.dev: Resend only delivers that to your own account email. Verify a domain in Resend and send from it to reach patients and doctors.');
    }
    return new ResendEmailSender(config.resendApiKey, config.emailFrom);
  }
  if (config.emailDelivery === 'log') return new LogEmailSender();
  return new DisabledEmailSender();
}
