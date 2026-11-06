import { Logger } from '@nestjs/common';
import { usesResendTestingSender, type AppConfig } from '../config.js';
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
 * Development only: prints the email in the terminal instead of sending it, so sign-up codes and invitation links can be tried
 * locally without an email provider. Anyone who can read the log can use what it prints, so config.ts never selects it in
 * production. Its result says `dev-log`, so callers never report an email as sent when it was only printed.
 */
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger('DevEmail');

  async send(message: EmailMessage): Promise<SendResult> {
    this.logger.log(`[DEV ONLY] NOT sent by email. To: ${message.to} | ${message.subject}\n${message.text}`);
    return { mode: 'dev-log' };
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

/**
 * Used in production when email is not set up. Sending fails at once, and not worth retrying: the outbox keeps the message as
 * FAILED with this reason instead of trying five times. The reason names the missing setting, never a value.
 */
export class DisabledEmailSender implements EmailSender {
  constructor(private readonly reason: string | null = null) {}

  async send(): Promise<never> {
    throw new DeliveryError(`Email is not configured${this.reason ? `: ${this.reason}` : '.'}`, false, 'email_not_configured');
  }
}

export function createEmailSender(config: Pick<AppConfig, 'emailDelivery' | 'resendApiKey' | 'emailFrom'> & { emailProblem?: string | null }): EmailSender {
  if (config.emailDelivery === 'resend') return new ResendEmailSender(config.resendApiKey, config.emailFrom);
  if (config.emailDelivery === 'log') return new LogEmailSender();
  return new DisabledEmailSender(config.emailProblem ?? null);
}

/** One line at start-up saying how email will be delivered, so a missing setting is never a surprise. Never prints a key or an address. */
export function announceEmailMode(config: Pick<AppConfig, 'emailDelivery' | 'emailFrom' | 'emailProblem'>): void {
  const logger = new Logger('Email');
  if (config.emailDelivery === 'resend') {
    logger.log(
      usesResendTestingSender(config.emailFrom)
        ? 'Email delivery: Resend with the testing sender. Messages reach only your own Resend account address; verify a domain and set EMAIL_FROM to email anyone else.'
        : 'Email delivery: Resend.',
    );
  } else if (config.emailDelivery === 'log') {
    logger.warn('[DEV ONLY] RESEND_API_KEY is not set: emails are printed in this terminal and NOT sent. Invitation links and sign-up codes appear here.');
  } else {
    logger.error(`Email delivery is OFF: ${config.emailProblem ?? 'not configured'} Sign-up, invitations and booking emails cannot be sent.`);
  }
}
