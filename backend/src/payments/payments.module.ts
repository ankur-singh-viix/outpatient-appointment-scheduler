import { Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PAYMENT_GATEWAY, createPaymentGateway } from './payment-gateway.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [PaymentsController],
  providers: [
    // Razorpay when RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set; otherwise a stand-in and booking stays free.
    { provide: PAYMENT_GATEWAY, useFactory: () => createPaymentGateway(loadConfig().payments) },
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
