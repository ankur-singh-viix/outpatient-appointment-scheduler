import { Module } from '@nestjs/common';
import { EMAIL_SENDER, createEmailSender } from '../auth/email-sender.js';
import { loadConfig } from '../config.js';
import { EmailChannel, NOTIFICATION_CHANNELS, SmsChannel } from './notification-channel.js';
import { NotificationsAdminController, NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { SMS_PROVIDER, createSmsProvider, type SmsProvider } from './sms-provider.js';

@Module({
  controllers: [NotificationsController, NotificationsAdminController],
  providers: [
    // The same email sender the sign-up codes use (tests replace it through the EMAIL_SENDER token).
    { provide: EMAIL_SENDER, useFactory: () => createEmailSender(loadConfig()) },
    // Twilio when its credentials are set, a development mock when SMS_PROVIDER=mock, otherwise off (tests replace it through SMS_PROVIDER).
    { provide: SMS_PROVIDER, useFactory: () => createSmsProvider(loadConfig().sms) },
    // To add WhatsApp or another way of reaching people: write a NotificationChannel and add it to this list.
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (email: ReturnType<typeof createEmailSender>, sms: SmsProvider) => [new EmailChannel(email), new SmsChannel(sms)],
      inject: [EMAIL_SENDER, SMS_PROVIDER],
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
