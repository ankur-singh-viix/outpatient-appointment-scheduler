import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AdminModule } from './admin/admin.module.js';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DoctorPortalModule } from './doctor-portal/doctor-portal.module.js';
import { DoctorsModule } from './doctors/doctors.module.js';
import { HealthController } from './health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { ReceptionistModule } from './receptionist/receptionist.module.js';

@Module({
  imports: [DatabaseModule, AuthModule, DoctorsModule, AppointmentsModule, DoctorPortalModule, ReceptionistModule, AdminModule, PaymentsModule, JobsModule, AssistantModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
