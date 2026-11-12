import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ScheduleChangesModule } from '../scheduling/schedule-changes.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { JobsService } from './jobs.service.js';

@Module({
  imports: [PaymentsModule, NotificationsModule, ScheduleChangesModule],
  providers: [JobsService],
})
export class JobsModule {}
