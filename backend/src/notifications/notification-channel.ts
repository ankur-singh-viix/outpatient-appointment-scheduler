import type { EmailSender } from '../auth/email-sender.js';
import type { SendResult } from './delivery-error.js';
import type { SmsProvider } from './sms-provider.js';

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * One way of reaching a person (email and SMS today; WhatsApp later). To add one, implement this, give it a unique `name`, make
 * the notifications table's channel check allow it, and register it in NotificationsModule. Rows in the outbox say which channel
 * they are for. `send` throws a DeliveryError when the message was not accepted.
 */
export interface NotificationChannel {
  readonly name: string;
  /** Whether messages should be queued for this channel at all (an SMS channel with no credentials is not). */
  readonly enabled: boolean;
  send(message: OutgoingMessage): Promise<SendResult>;
}

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/** Email through the sender the app already uses for sign-up codes (Resend, or the server log in development). */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email';
  readonly enabled = true;

  constructor(private readonly sender: EmailSender) {}

  async send(message: OutgoingMessage): Promise<SendResult> {
    return (await this.sender.send({ to: message.to, subject: message.subject, text: message.body })) ?? {};
  }
}

/** Text messages through the configured SmsProvider. The subject is not used: a text is only its body. */
export class SmsChannel implements NotificationChannel {
  readonly name = 'sms';

  constructor(private readonly provider: SmsProvider) {}

  get enabled(): boolean {
    return this.provider.enabled;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    return this.provider.send({ to: message.to, body: message.body });
  }
}
