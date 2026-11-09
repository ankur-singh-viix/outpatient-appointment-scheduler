import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ScheduleChangeNotifier } from './schedule-change-notifier.service.js';

@Module({
  imports: [NotificationsModule],
  providers: [ScheduleChangeNotifier],
  exports: [ScheduleChangeNotifier],
})
export class ScheduleChangesModule {}
