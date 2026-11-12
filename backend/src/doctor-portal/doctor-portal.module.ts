import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ScheduleChangesModule } from '../scheduling/schedule-changes.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AvailabilityChangeService } from './availability-change.service.js';
import { DoctorPortalController } from './doctor-portal.controller.js';
import { DoctorPortalService } from './doctor-portal.service.js';

@Module({
  imports: [PaymentsModule, NotificationsModule, ScheduleChangesModule],
  controllers: [DoctorPortalController],
  providers: [DoctorPortalService, AvailabilityChangeService],
})
export class DoctorPortalModule {}
