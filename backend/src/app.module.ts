import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DoctorPortalModule } from './doctor-portal/doctor-portal.module.js';
import { DoctorsModule } from './doctors/doctors.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule, DoctorsModule, AppointmentsModule, DoctorPortalModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
