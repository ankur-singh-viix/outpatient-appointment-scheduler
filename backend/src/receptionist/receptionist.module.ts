import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module.js';
import { ReceptionistController } from './receptionist.controller.js';
import { ReceptionistService } from './receptionist.service.js';

@Module({
  imports: [AppointmentsModule],
  controllers: [ReceptionistController],
  providers: [ReceptionistService],
})
export class ReceptionistModule {}
