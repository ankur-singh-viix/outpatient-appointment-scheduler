import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { DoctorPortalController } from './doctor-portal.controller.js';
import { DoctorPortalService } from './doctor-portal.service.js';

@Module({
  imports: [PaymentsModule, NotificationsModule],
  controllers: [DoctorPortalController],
  providers: [DoctorPortalService],
})
export class DoctorPortalModule {}
