import { Module } from '@nestjs/common';
import { EMAIL_SENDER, createEmailSender } from '../auth/email-sender.js';
import { loadConfig } from '../config.js';
import { EmailChannel, NOTIFICATION_CHANNELS } from './notification-channel.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  providers: [
    // The same email sender the sign-up codes use (tests replace it through the EMAIL_SENDER token).
    { provide: EMAIL_SENDER, useFactory: () => createEmailSender(loadConfig()) },
    // To add SMS or WhatsApp: write a NotificationChannel and add it to this list.
    { provide: NOTIFICATION_CHANNELS, useFactory: (email: ReturnType<typeof createEmailSender>) => [new EmailChannel(email)], inject: [EMAIL_SENDER] },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
