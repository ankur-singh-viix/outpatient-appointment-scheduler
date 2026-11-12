import { Logger } from '@nestjs/common';
import { parseSender, usesResendTestingSender, type AppConfig } from '../config.js';
import { DeliveryError, isRetryableStatus, type SendResult } from '../notifications/delivery-error.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** An HTML version for mail clients that show one. Optional: sign-up codes and invitations are plain text. */
  html?: string;
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
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) }),
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

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
/** Deliberately simple: Brevo makes the final call. This only stops an obviously unusable address from costing a request and a retry. */
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Sends through Brevo's transactional email API (https://developers.brevo.com/reference/sendtransacemail), over HTTPS with the
 * `api-key` header; no extra package. Needs BREVO_API_KEY and a sender verified in Brevo (EMAIL_FROM). A refusal that retrying
 * cannot fix (an invalid recipient, a bad key, an unverified sender) is a non-retryable DeliveryError, so the outbox keeps the
 * message as FAILED with Brevo's reason instead of trying five times; a timeout, a rate limit or an outage is retried.
 * The key is only ever in the request header, never in a message, log or error.
 */
export class BrevoEmailSender implements EmailSender {
  private readonly sender: { name?: string; email: string };

  constructor(
    private readonly apiKey: string,
    from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = parseSender(from);
    if (!parsed) throw new Error('EMAIL_FROM is not a valid sender address.');
    this.sender = { ...(parsed.name ? { name: parsed.name } : {}), email: parsed.email };
  }

  async send(message: EmailMessage): Promise<SendResult> {
    if (!ADDRESS.test(message.to.trim())) throw new DeliveryError('The recipient address is not a valid email address.', false, 'invalid_recipient');
    let response: Response;
    try {
      response = await this.fetchImpl(BREVO_URL, {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: this.sender,
          to: [{ email: message.to.trim() }],
          subject: message.subject,
          textContent: message.text,
          ...(message.html ? { htmlContent: message.html } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DeliveryError('Could not reach Brevo.', true);
    }
    // Brevo explains a refusal in the body ({ code, message }); a bare status hides the reason (an unverified sender, a blocked IP).
    const body = (await response.json().catch(() => null)) as { messageId?: string; code?: string; message?: string } | null;
    if (!response.ok) {
      const reason = [body?.code, body?.message].filter(Boolean).join(': ').slice(0, 300);
      throw new DeliveryError(`Brevo responded with HTTP ${response.status}${reason ? ` (${reason})` : ''}`, isRetryableStatus(response.status), body?.code);
    }
    return { reference: body?.messageId };
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

export function createEmailSender(config: Pick<AppConfig, 'emailDelivery' | 'resendApiKey' | 'emailFrom'> & { brevoApiKey?: string; emailProblem?: string | null }): EmailSender {
  if (config.emailDelivery === 'brevo') return new BrevoEmailSender(config.brevoApiKey ?? '', config.emailFrom);
  if (config.emailDelivery === 'resend') return new ResendEmailSender(config.resendApiKey, config.emailFrom);
  if (config.emailDelivery === 'log') return new LogEmailSender();
  return new DisabledEmailSender(config.emailProblem ?? null);
}

/** One line at start-up saying how email will be delivered, so a missing setting is never a surprise. Never prints a key or an address. */
export function announceEmailMode(config: Pick<AppConfig, 'emailDelivery' | 'emailFrom' | 'emailProblem'>): void {
  const logger = new Logger('Email');
  if (config.emailDelivery === 'brevo') {
    logger.log('Email delivery: Brevo.');
  } else if (config.emailDelivery === 'resend') {
    logger.log(
      usesResendTestingSender(config.emailFrom)
        ? 'Email delivery: Resend with the testing sender. Messages reach only your own Resend account address; verify a domain and set EMAIL_FROM to email anyone else.'
        : 'Email delivery: Resend.',
    );
  } else if (config.emailDelivery === 'log') {
    logger.warn(
      config.emailProblem
        ? `[DEV ONLY] An email provider key is set but cannot be used: ${config.emailProblem} Emails are printed in this terminal and NOT sent.`
        : '[DEV ONLY] No email provider key is set (BREVO_API_KEY or RESEND_API_KEY): emails are printed in this terminal and NOT sent. Invitation links and sign-up codes appear here.',
    );
  } else {
    logger.error(`Email delivery is OFF: ${config.emailProblem ?? 'not configured'} Sign-up, invitations and booking emails cannot be sent.`);
  }
}
