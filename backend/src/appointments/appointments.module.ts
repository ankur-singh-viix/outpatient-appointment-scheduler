import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AppointmentHistoryService } from './appointment-history.service.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';

@Module({
  imports: [PaymentsModule, NotificationsModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, AppointmentHistoryService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
