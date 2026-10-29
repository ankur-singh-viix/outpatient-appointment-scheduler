import type { EmailSender } from '../auth/email-sender.js';

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * One way of reaching a person (email today; SMS or WhatsApp later). To add one, implement this, give it a unique `name`
 * and register it in NotificationsModule. Rows in the outbox say which channel they are for.
 */
export interface NotificationChannel {
  readonly name: string;
  send(message: OutgoingMessage): Promise<void>;
}

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/** Email through the sender the app already uses for sign-up codes (Resend, or the server log in development). */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email';

  constructor(private readonly sender: EmailSender) {}

  async send(message: OutgoingMessage): Promise<void> {
    await this.sender.send({ to: message.to, subject: message.subject, text: message.body });
  }
}
