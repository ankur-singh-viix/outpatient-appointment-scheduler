import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Anything that can deliver an email. Swapped for a recording fake in tests. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
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

  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
    });
    if (!response.ok) throw new Error(`Resend responded with HTTP ${response.status}`);
  }
}

/** Used when no provider is configured in production: sign-up is refused before this is ever called. */
export class DisabledEmailSender implements EmailSender {
  async send(): Promise<void> {
    throw new Error('Email delivery is not configured.');
  }
}

export function createEmailSender(config: Pick<AppConfig, 'emailDelivery' | 'resendApiKey' | 'emailFrom'>): EmailSender {
  if (config.emailDelivery === 'resend') return new ResendEmailSender(config.resendApiKey, config.emailFrom);
  if (config.emailDelivery === 'log') return new LogEmailSender();
  return new DisabledEmailSender();
}
